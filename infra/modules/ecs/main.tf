variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "alb_target_group_arn" {
  type = string
}

variable "image_uri" {
  type        = string
  description = "Full ECR image URI including tag, set by the CI/CD pipeline on deploy"
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "cpu" {
  type    = number
  default = 512
}

variable "memory" {
  type    = number
  default = 1024
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "log_group_name" {
  type = string
}

variable "secret_arns" {
  description = "Map from the secrets module — database_url, jwt_secret, jwt_refresh_secret, paystack_secret_key, smtp_pass"
  type        = map(string)
}

variable "non_secret_env" {
  description = "Non-sensitive env vars — NODE_ENV, PORT, FRONTEND_URL, ALLOWED_ORIGINS, SMTP_HOST etc."
  type        = map(string)
  default     = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

resource "aws_security_group" "ecs_task" {
  name        = "${var.name}-ecs-task-sg"
  description = "Allow inbound only from the ALB security group"
  vpc_id      = var.vpc_id

  ingress {
    description     = "From ALB only"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-ecs-task-sg" })
}

# ── Execution role: pulls the image, writes logs, resolves secrets ─────
# This is the role ECS itself assumes to start the task — distinct from
# the task role below, which is what the *application code* assumes.
resource "aws_iam_role" "execution" {
  name = "${var.name}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Scoped to exactly the five secret ARNs this app needs — not
# secretsmanager:* — so a compromised task can't enumerate or read
# unrelated secrets in the account.
resource "aws_iam_role_policy" "execution_secrets" {
  name = "${var.name}-ecs-execution-secrets-policy"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = values(var.secret_arns)
    }]
  })
}

# ── Task role: what the running application assumes ────────────────────
# Currently the app doesn't call other AWS services directly (Paystack is
# external HTTPS), so this starts empty. Attach policies here — not to
# the execution role — if the app later needs e.g. SES send permissions
# directly rather than SMTP, or S3 access for file uploads.
resource "aws_iam_role" "task" {
  name = "${var.name}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = var.tags
}

locals {
  secrets_for_container = [
    { name = "DATABASE_URL", valueFrom = var.secret_arns["database_url"] },
    { name = "JWT_SECRET", valueFrom = var.secret_arns["jwt_secret"] },
    { name = "JWT_REFRESH_SECRET", valueFrom = var.secret_arns["jwt_refresh_secret"] },
    { name = "PAYSTACK_SECRET_KEY", valueFrom = var.secret_arns["paystack_secret_key"] },
    { name = "SMTP_PASS", valueFrom = var.secret_arns["smtp_pass"] },
  ]

  env_for_container = [
    for k, v in var.non_secret_env : { name = k, value = v }
  ]
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.name}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # No secret values or DB credentials appear anywhere in this JSON —
  # only ARNs. The README's "no env vars in the task definition itself"
  # requirement is enforced structurally here, not by convention.
  container_definitions = jsonencode([
    {
      name      = "opsshield-app"
      image     = var.image_uri
      essential = true

      portMappings = [{
        containerPort = var.container_port
        protocol      = "tcp"
      }]

      environment = local.env_for_container
      secrets     = local.secrets_for_container

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "app"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:${var.container_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])

  tags = var.tags
}

data "aws_region" "current" {}

resource "aws_ecs_service" "this" {
  name            = "${var.name}-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_task.id]
    assign_public_ip = false # private subnets only, egress via NAT
  }

  load_balancer {
    target_group_arn = var.alb_target_group_arn
    container_name    = "opsshield-app"
    container_port    = var.container_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # No lifecycle.ignore_changes here deliberately — the deploy path is
  # `terraform apply -var="image_uri=..."` from CI, which creates a new
  # task_definition revision and must be allowed to push it to the service.
  # If you ever bypass Terraform with a manual `aws ecs update-service`,
  # the next `terraform apply` will revert the service back to whatever
  # image_uri Terraform still thinks is current — don't hand-deploy.
  tags = var.tags
}

# ── Auto Scaling — Cloud team's "load test run to prove it handles a
# traffic spike" checklist item depends on this being wired, not just
# desired_count being set statically ──────────────────────────────────
resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.desired_count * 4
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.this.name
}

output "task_security_group_id" {
  value = aws_security_group.ecs_task.id
}
