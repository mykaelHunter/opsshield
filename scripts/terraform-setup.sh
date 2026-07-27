aws s3 mb s3://opsshield-terraform-state-prod --region eu-west-1

# Enable versioning (so you can recover from bad state)
aws s3api put-bucket-versioning \
  --bucket opsshield-terraform-state-prod \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket opsshield-terraform-state-prod \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
