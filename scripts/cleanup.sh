#!/bin/bash

set -euo pipefail

echo "Manually empty and delete the alb log bucket before running the script"
# This is because the terraform destroy process creates logs in the bucket
echo "Make sure you have edited the variables before running this script"
echo "Do not run the script unless you are absolutely sure of what you are doing"
echo ""
sleep 30s

ENV=<environment>
ACCOUNT_ID=<your-iam-account-id>
AWS_REGION=<your-region>
FRONTEND_BUCKET=opsshield-${ENV}-frontend-${ACCOUNT_ID}
STATE_STORE=<your_s3_state_bucket>
export TF_VAR_paystack_secret_key="sk_test_....."
export TF_VAR_smtp_pass="<Any hex string>"

echo "Starting cleanup of infra"
echo ""

echo "Deleting any previous db snapshots"
echo ""

aws rds delete-db-snapshot --db-snapshot-identifier opsshield-${ENV}-db-final-snapshot
echo "Done"
echo ""

echo "Removing delete protection from the db"
echo ""
aws rds modify-db-instance --db-instance-identifier opsshield-${ENV}-db --no-deletion-protection --apply-immediately
echo "Done"
echo ""

echo "Deleting ecr images"
echo ""
aws ecr batch-delete-image \
  --repository-name opsshield \
  --image-ids "$(aws ecr list-images --repository-name opsshield --query 'imageIds[*]' --output json)"
echo "Done"
echo ""

echo "Emptying s3 bucket for frontend"

aws s3api delete-objects \
    --bucket ${FRONTEND_BUCKET} \
    --delete "$(aws s3api list-object-versions \
    --bucket ${FRONTEND_BUCKET} \
    --output json \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}')"

echo ""
echo "Buckets cleaned"

echo "Destroying infra"
echo ""
cd ..
cd infra/envs/${ENV}
terraform destroy -var="image_uri=$(terraform output -raw ecr_repository_url):latest" -auto-approve
echo ""
echo "Destruction complete"
echo ""

echo "Deleting ecr repository"
if [[ ${ENV} == "staging" ]]; then
        cd ..
        cd ..
        cd ..
        cd infra/envs/prod
        terraform destroy -var="image_uri=$(terraform output -raw ecr_repository_url):latest" -auto-approve
else
        echo "This is production"
        exit 0
fi

echo ""
echo "Stop the script if terraform destroy failed"
echo ""
sleep 45s

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

aws logs delete-log-group --log-group-name "/opsshield/opsshield-${ENV}/vpc-flow-logs" --region ${AWS_REGION}
aws logs delete-log-group --log-group-name "/aws/ecs/containerinsights/opsshield-${ENV}-cluster/performance" --region ${AWS_REGION}
aws logs delete-log-group --log-group-name "/aws/rds/instance/opsshield-${ENV}-db/postgresql" --region ${AWS_REGION}
echo ""
echo "Deletion of logs complete"

