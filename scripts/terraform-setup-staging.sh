#!/bin/bash

set -euo pipefail

echo "Make sure you have edited in the correct variables before running script"
echo "Make sure you have a terraform tfvars file in the infra/envs/prod"
echo "You can use the terraform.tfvars.example as a template"
echo "You have 10s to cancel if you have not"
sleep 10s

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=$(aws configure get region)
export TF_VAR_paystack_secret_key="sk_test_....."
export TF_VAR_smtp_pass="<Any hex string>" 

echo "Creating bucket for state locking"
aws s3 mb s3://opsshield-terraform-state-prod --region ${AWS_REGION}

# Enable versioning (so you can recover from bad state)
aws s3api put-bucket-versioning \
  --bucket opsshield-terraform-state-prod \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket opsshield-terraform-state-prod \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

echo "Bucket for state locking done"
echo ""

echo "Creating ecr repository"
echo ""

cd ..
cd infra/envs/prod
terraform init
terraform apply -target=module.ecr -var="image_uri=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/opsshield:latest" -auto-approve
echo "done"

cd ..
cd ..
cd ..

cd infra/envs/staging

echo "Provisioning infra"

terraform init
terraform plan -var="image_uri=${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/opsshield:latest" -out=path
terraform apply "path"


