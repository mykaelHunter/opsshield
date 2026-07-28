#!/bin/bash

set -euo pipefail

echo "Make sure you have edited the variables before running this script"
echo "Do not run the script unless you are absolutely sure of what you are doing"
echo ""
sleep 30s

AWS_REGION=<your-region>
ALB_BUCKET=<your_alb_bucket_name>
FRONTEND_BUCKET=<frontend_bucket_name>
STATE_STORE=<your_s3_state_bucket>
export TF_VAR_paystack_secret_key="sk_test_....."
export TF_VAR_smtp_pass="<Any hex string>"

echo "Starting cleanup of infra"
echo ""

echo "Deleting any previous db snapshots"
echo ""
aws rds delete-db-snapshot --db-snapshot-identifier opsshield-db-final-snapshot
echo ""

echo "Removing delete protection from the db"
echo ""
aws rds modify-db-instance --db-instance-identifier opsshield-prod-db --no-deletion-protection --apply-immediately
echo ""

echo "Emptying s3 buckets for frontend and alb logs"

aws s3api delete-objects \
    --bucket ${ALB_BUCKET} \
    --delete "$(aws s3api list-object-versions \
    --bucket ${ALB_BUCKET} \
    --output json \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}')"

aws s3api delete-objects \
    --bucket ${ALB_BUCKET} \
    --delete "$(aws s3api list-object-versions \
    --bucket ${ALB_BUCKET} \
    --output json \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}')"

aws s3api delete-objects \
    --bucket ${FRONTEND_BUCKET} \
    --delete "$(aws s3api list-object-versions \
    --bucket ${FRONTEND_BUCKET} \
    --output json \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}')"

aws s3api delete-objects \
    --bucket ${FRONTEND_BUCKET} \
    --delete "$(aws s3api list-object-versions \
    --bucket ${FRONTEND_BUCKET} \
    --output json \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}')"

echo ""
echo "Buckets cleaned"

echo "Destroying infra"
echo ""
cd ..
cd infra/envs/prod
terraform destroy -var="image_uri=$(terraform output -raw ecr_repository_url):latest" -auto-approve
echo ""
echo "Destruction complete"
echo ""

echo "Empty and delete s3 state bucket"
aws s3api delete-objects \
    --bucket ${STATE_STORE} \
    --delete "$(aws s3api list-object-versions \
    --bucket ${STATE_STORE} \
    --output json \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}')"

aws s3api delete-objects \
    --bucket ${STATE_STORE} \
    --delete "$(aws s3api list-object-versions \
    --bucket ${STATE_STORE} \
    --output json \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}')"
aws s3 rb s3://${STATE_STORE}
echo ""
echo "State lock deletion complete"
echo ""

echo "Deleting cloudwatch logs(optional)"
echo "You have 30s to decide"
sleep 30s

aws logs delete-log-group --log-group-name "/opsshield/opsshield-prod/vpc-flow-logs" --region ${AWS_REGION}
echo ""
echo "Deletion of logs complete"

