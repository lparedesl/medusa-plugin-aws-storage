# medusa-plugin-aws-storage

Upload files to an AWS S3 bucket. Optionally serve files through CloudFront.

## Options

| Option                                  | Description                                                                                                                                                                                                                                                                                               | Required | Example            |
|-----------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|--------------------|
| region                                  | AWS region                                                                                                                                                                                                                                                                                                | Yes      | `us-east-1`        |
| access_key_id                           | AWS Access Key ID                                                                                                                                                                                                                                                                                         | Yes      |                    |
| secret_access_key                       | AWS Secret Access Key                                                                                                                                                                                                                                                                                     | Yes      |                    |
| s3_bucket                               | S3 bucket name                                                                                                                                                                                                                                                                                            | Yes      |                    |
| s3_origin_path                          | S3 origin. If `cloud_front_distribution_id` is provided then origin path has to be part of the distribution's S3 origins. If `cloud_front_distribution_id` is provided and `s3_origin_path` is not provided, then the distribution's default cache behavior's origin path will be used. Defaults to `''`. |          | `/assets`          |
| upload_options                          | S3 upload options                                                                                                                                                                                                                                                                                         |          | `{}`               |
| s3_upload_options.ACL                   | S3 ACL                                                                                                                                                                                                                                                                                                    |          | `public-read`      |
| s3_upload_options.CacheControl          | S3 Cache Control                                                                                                                                                                                                                                                                                          |          | `max-age=31536000` |
| s3_upload_options.ServerSideEncryption  | S3 Server Side Encryption                                                                                                                                                                                                                                                                                 |          | `AES256`           |
| s3_upload_options.StorageClass          | S3 Storage Class                                                                                                                                                                                                                                                                                          |          | `STANDARD`         |
| cloud_front_distribution_id             | CloudFront Distribution ID                                                                                                                                                                                                                                                                                |          |                    |
| cloud_front_cache_behavior_path_pattern | CloudFront Cache Behavior Path Pattern. Used when other than default cache behavior needs to be used. If not provided, then the default cache behavior will be used. Ignored when `cloud_front_distribution_id` is not provided.                                                                          |          | `images/*`         |
| domain_name                             | Domain name. If `cloud_front_distribution_id` is provided then domain name has to be part of the distribution's aliases. If `cloud_front_distribution_id` is provided and `domain_name` is not provided, then the 1st distribution alias will be used. Defaults to S3 Bucket URL.                         |          | `my-domain.com`    |
| download_url_duration                   | The number of seconds before the presigned URL expires                                                                                                                                                                                                                                                    |          | `3600`             |
| use_https                               | Whether to use `http` or `https`                                                                                                                                                                                                                                                                          |          | `true`             |

## Usage

```js
const plugins = [
  // ...
  {
    resolve: `medusa-plugin-aws-storage`,
    options: {
      region: process.env.S3_REGION,
      access_key_id: process.env.S3_ACCESS_KEY_ID,
      secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
      s3_bucket: process.env.S3_BUCKET,
    },
  },
]
```

## S3 Bucket Policy

```json
{
  "Version": "2012-10-17",
  "Id": "Policy1397632521960",
  "Statement": [
    {
      "Sid": "Stmt1397633323327",
      "Effect": "Allow",
      "Principal": {
        "AWS": "*"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<YOUR_BUCKET_NAME>/*"
    }
  ]
}
```

## User Permissions

Your user must have the `AmazonS3FullAccess` policy attached to it. You can refer to [this guide](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-create-and-attach-iam-policy.html) to learn how to add a policy if necessary.

If using CloudFront, your user must have the `CloudFrontFullAccess` policy attached to it.
