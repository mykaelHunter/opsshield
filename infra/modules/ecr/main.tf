variable "name" {
  type        = string
  description = "Repository name — must match what CI's docker build/push and Terraform's image_uri both expect (e.g. \"opsshield\")"
}

variable "untagged_expiry_days" {
  type    = number
  default = 7
  description = "Untagged images (superseded builds, failed pushes) older than this are cleaned up automatically"
}

variable "keep_tagged_count" {
  type    = number
  default = 20
  description = "How many tagged images to retain — older ones beyond this count are expired"
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_ecr_repository" "this" {
  name                 = var.name
  # MUTABLE because ci.yml currently re-pushes the ":latest" tag on every
  # build. IMMUTABLE (each tag can only ever be pushed once) is the safer
  # long-term choice — it stops a compromised CI run from silently
  # overwriting an existing tag — but switching requires CI to stop
  # pushing ":latest" and rely solely on the git-SHA tag instead. Worth
  # doing once that CI change is made; not the default here to avoid
  # breaking the existing pipeline on `terraform apply`.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true # feeds the same Trivy-style vulnerability visibility Security already relies on in CI
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = var.tags
}

# Without this, the repository accumulates every image ever pushed —
# untagged layers from superseded builds pile up fastest and cost the
# most for the least value.
resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after ${var.untagged_expiry_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_expiry_days
        }
        action = { type = "expire" }
      },
      {
        # tagStatus "any" must be the single lowest-priority (highest
        # rulePriority number) rule in the policy — AWS evaluates it last,
        # after the more specific untagged rule above has already run.
        rulePriority = 2
        description  = "Keep only the most recent ${var.keep_tagged_count} images overall, tagged or not"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.keep_tagged_count
        }
        action = { type = "expire" }
      }
    ]
  })
}

output "repository_url" {
  value = aws_ecr_repository.this.repository_url
}

output "repository_name" {
  value = aws_ecr_repository.this.name
}

output "repository_arn" {
  value = aws_ecr_repository.this.arn
}
