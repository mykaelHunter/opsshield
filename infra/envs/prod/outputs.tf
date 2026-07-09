output "alb_dns_name" {
  value = module.alb.dns_name
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
