output "alb_dns_name" {
  value = module.alb.dns_name
}

output "frontend_url" {
  value = module.frontend.frontend_url
}

output "frontend_bucket_name" {
  description = "Deploy target for CI — sync built assets here"
  value       = module.frontend.bucket_name
}

output "frontend_distribution_id" {
  description = "Needed by CI to invalidate the CloudFront cache after each deploy"
  value       = module.frontend.distribution_id
}

output "ecr_repository_url" {
  description = "Shared repo owned by infra/envs/prod — push images here, then pass <this>:<tag> as image_uri"
  value       = data.aws_ecr_repository.opsshield.repository_url
}

output "app_url" {
  value = "https://${var.domain_name}"
}

output "route53_name_servers" {
  description = "Point your domain registrar at these"
  value       = module.dns_acm.name_servers
}

output "ecs_cluster_name" {
  value = module.ecs.cluster_name
}

output "ecs_service_name" {
  value = module.ecs.service_name
}

output "ecs_task_definition_arn" {
  value = module.ecs.task_definition_arn
}

output "ecs_private_subnet_ids" {
  value = module.vpc.private_subnet_ids
}

output "ecs_service_security_group_id" {
  value = module.ecs.task_security_group_id
}

output "rds_endpoint" {
  value = module.rds.endpoint
}

output "cloudwatch_log_group" {
  value = module.cloudwatch.log_group_name
}

# github_deploy_role_arn is not output here — that role is created once,
# in infra/envs/prod's state (see main.tf note above). Read it from the
# prod output instead: `terraform output -raw github_deploy_role_arn`
# from within infra/envs/prod.
