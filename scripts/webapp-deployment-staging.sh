#!/bin/bash

set -euo pipefail

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region)
export TF_VAR_paystack_secret_key="sk_test_....."
export TF_VAR_smtp_pass="<Any hex string>"
export VITE_API_URL="https://<backend_domain_url_from_terraform>"

cd ..

echo "Starting Backend deployment"
echo ""
echo "Image buiding and pushing"
echo ""

aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
docker build -t opsshield .
docker tag opsshield:latest ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/opsshield:latest
docker push ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/opsshield:latest

echo "Image pushed successfully"
echo ""
sleep 30s

echo "Running database migrations"
echo ""

cd infra/envs/staging

CLUSTER=$(terraform output -raw ecs_cluster_name)
TASK_DEF=$(terraform output -raw ecs_task_definition_arn)
SUBNETS=$(terraform output -json ecs_private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw ecs_service_security_group_id)

TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASK_DEF" --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" --overrides '{"containerOverrides":[{"name":"opsshield-app","command":["node","node_modules/prisma/build/index.js","migrate","deploy"]}]}' --region ${AWS_REGION} --query 'tasks[0].taskArn' --output text)

echo "Migration task: $TASK_ARN"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region ${AWS_REGION}

MIGRATE_EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region ${AWS_REGION} --query 'tasks[0].containers[0].exitCode' --output text)

echo "Migration exit code: $MIGRATE_EXIT"

if [ "$MIGRATE_EXIT" != "0" ]; then
  echo "Migration failed — not running seed."
  exit 1
fi

SEED_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASK_DEF" --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" --overrides '{"containerOverrides":[{"name":"opsshield-app","command":["node","prisma/seed.js"]}]}' --region ${AWS_REGION} --query 'tasks[0].taskArn' --output text)

echo "Seed task: $SEED_ARN"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$SEED_ARN" --region ${AWS_REGION}

aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$SEED_ARN" --region ${AWS_REGION} --query 'tasks[0].containers[0].{exitCode:exitCode,reason:reason}'

echo ""
echo "Migrations complete"
echo ""
sleep 10s

echo "Starting Frontend deployment"
cd ..
cd ..
cd ..
cd frontend
npm install
npm run build

echo ""
echo "Pushing frontend artifact to s3"
echo""

aws s3 sync dist/ "s3://$(cd ../infra/envs/staging && terraform output -raw frontend_bucket_name)" --delete
