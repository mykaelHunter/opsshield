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
  description = "Push images here, then pass <this>:<tag> as image_uri on future applies"
  value       = module.ecr.repository_url
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

output "rds_endpoint" {
  value = module.rds.endpoint
}

output "cloudwatch_log_group" {
  value = module.cloudwatch.log_group_name
}

output "github_deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN secret in the GitHub repo (Settings > Secrets and variables > Actions)"
  value       = module.github_oidc.role_arn
}
