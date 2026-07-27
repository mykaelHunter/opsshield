#!/usr/bin/env bash
set -euo pipefail

# Builds the frontend and deploys it to the S3/CloudFront infra created by
# infra/modules/frontend. Run from the frontend/ directory.
#
# Requires: the infra/envs/prod stack already applied (needs
# frontend_bucket_name and frontend_distribution_id as outputs).

cd "$(dirname "$0")"

echo "==> Building..."
npm run build

TF_DIR="../infra/envs/prod"
BUCKET=$(cd "$TF_DIR" && terraform output -raw frontend_bucket_name)
DISTRIBUTION_ID=$(cd "$TF_DIR" && terraform output -raw frontend_distribution_id)

echo "==> Syncing to s3://${BUCKET}..."
aws s3 sync dist/ "s3://${BUCKET}" --delete

echo "==> Invalidating CloudFront cache (${DISTRIBUTION_ID})..."
aws cloudfront create-invalidation --distribution-id "${DISTRIBUTION_ID}" --paths "/*"

FRONTEND_URL=$(cd "$TF_DIR" && terraform output -raw frontend_url)
echo "==> Done. Live at ${FRONTEND_URL} (allow a minute or two for the invalidation to finish)."
