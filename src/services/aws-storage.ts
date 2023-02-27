import { createReadStream } from 'fs';
import { PassThrough, Readable } from 'stream';
import { AbstractFileService } from '@medusajs/medusa';
import {
  CacheBehavior,
  CloudFrontClient,
  CreateInvalidationCommand,
  Distribution,
  DistributionConfig,
  GetDistributionCommand,
  Origin,
} from '@aws-sdk/client-cloudfront';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommandOutput,
  PutObjectCommandInput,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import {
  DeleteFileType,
  FileServiceGetUploadStreamResult,
  FileServiceUploadResult,
  GetUploadedFileType,
  UploadStreamDescriptorType,
} from '@medusajs/medusa/dist/interfaces/file-service';
import { EntityManager } from 'typeorm';

class AwsStorageService extends AbstractFileService {
  protected readonly s3Client_: S3Client;
  protected readonly cloudFrontClient_: CloudFrontClient;
  protected readonly protocol_: string;
  protected readonly cloudFrontDistributionId_: string;
  protected readonly uploadOptions_: Pick<PutObjectCommandInput, 'ACL' | 'CacheControl' | 'ServerSideEncryption' | 'StorageClass'>;
  protected readonly domainName_: string;
  protected readonly s3OriginPath_: string;
  protected readonly cacheBehaviorPathPattern_: string;
  protected readonly downloadUrlDuration_: number;
  protected readonly cloudFrontKeyPairId_: string;
  protected readonly cloudFrontKeyPrivateKey_: string;
  protected bucketName_: string;
  protected cloudFrontDistribution_: Distribution;
  protected s3Origin_: Origin;
  protected baseUrl_: string;
  protected cacheBehavior_: CacheBehavior;

  protected readonly manager_: EntityManager;
  protected readonly transactionManager_: EntityManager | undefined;

  constructor(container, options) {
    super(container, options);

    if (!options.access_key_id || !options.secret_access_key) {
      console.error('You must provide an access key ID and a secret access key');
    }

    if (!options.region) {
      console.error('You must provide a region');
    }

    if (!options.s3_bucket && !options.cloud_front_distribution_id) {
      console.error('You must provide either a S3 bucket name or a CloudFront distribution ID');
    }

    const commonAwsConfig = {
      region: options.region,
      credentials: {
        accessKeyId: options.access_key_id,
        secretAccessKey: options.secret_access_key,
      },
    };
    this.s3Client_ = new S3Client(commonAwsConfig);
    this.cloudFrontClient_ = new CloudFrontClient(commonAwsConfig);

    this.protocol_ = options.use_https ? 'https' : 'http'
    this.bucketName_ = options.s3_bucket;
    this.s3OriginPath_ = options.s3_origin_path;
    this.uploadOptions_ = options.s3_upload_options || {};
    this.cloudFrontDistributionId_ = options.cloud_front_distribution_id;
    this.domainName_ = options.domain_name;
    this.cacheBehaviorPathPattern_ = options.cloud_front_cache_behavior_path_pattern;
    this.downloadUrlDuration_ = options.download_url_duration;
    this.cloudFrontKeyPairId_ = options.cloud_front_key_pair_id;
    this.cloudFrontKeyPrivateKey_ = options.cloud_front_key_private_key;
  }

  private async getCloudFrontDistribution(distributionId: string): Promise<Distribution> {
    const response = await this.cloudFrontClient_.send(
      new GetDistributionCommand({
        Id: distributionId,
      })
    );

    if (!response) {
      throw new Error('Could not get CloudFront distribution');
    }

    return response.Distribution;
  }

  private setDefaults(s3OriginPath: string, domainName?: string): void {
    this.baseUrl_ = `${this.protocol_}://${this.bucketName_}.s3.amazonaws.com`;
    this.s3Origin_ = null;
    this.cacheBehavior_ = null;

    if (domainName) {
      this.baseUrl_ = `${this.protocol_}://${domainName}`;
    }

    if (s3OriginPath) {
      this.s3Origin_ = {
        Id: '',
        DomainName: `${this.bucketName_}.s3.amazonaws.com`,
        OriginPath: s3OriginPath,
      };
    }
  }

  /**
   * @summary This method only runs when the CloudFront distribution ID is provided.
   */
  private setBaseUrl(distribution: Distribution, domainName: string): string {
    let baseUrl = `${this.bucketName_}.s3.amazonaws.com`;
    const distributionConfig = distribution.DistributionConfig;

    if (distribution.DomainName) {
      baseUrl = distribution.DomainName;
    }

    if (domainName) {
      if (distributionConfig?.Aliases?.Items?.length) {
        if (!distributionConfig.Aliases.Items.includes(domainName)) {
          console.warn(`Domain name '${domainName}' is not included in the CloudFront distribution aliases. Using distribution domain name.`);
        } else {
          baseUrl = domainName;
        }
      } else if (domainName) {
        console.warn('CloudFront distribution does not have any aliases. Using distribution domain name.');
      }
    }

    return `${this.protocol_}://${baseUrl}`;
  }

  /**
   * @summary This method only runs when the CloudFront distribution ID is provided.
   */
  private setS3Origin(distributionConfig: DistributionConfig, s3Origin: string): Origin {
    const s3Origins = distributionConfig.Origins?.Items?.filter((o) => {
      return o.DomainName.endsWith('.s3.amazonaws.com');
    }) ?? [];
    const defaultCacheBehaviorOriginId = distributionConfig.DefaultCacheBehavior?.TargetOriginId;
    let origin = s3Origins.find((o) => o.Id === defaultCacheBehaviorOriginId) ?? s3Origins[0];
    const notFoundMessage = `S3 origin path '${s3Origin}' is not included in the CloudFront distribution origins. Using default cache behavior S3 origin.`;

    if (s3Origins.length) {
      if (s3Origin) {
        const foundOrigin = s3Origins.find((o) => o.OriginPath === s3Origin);

        if (!foundOrigin && origin) {
          console.warn(notFoundMessage);
        } else {
          origin = foundOrigin;
        }
      }
    } else if (s3Origin && origin) {
      console.warn(notFoundMessage);
    }

    if (!origin) {
      console.error('Could not find S3 origin');
    }

    return origin;
  }

  /**
   * @summary This method only runs when the CloudFront distribution ID is provided.
   */
  private validateS3BucketName(origin: Origin | null): void {
    const originBucketName = origin.DomainName.replace('.s3.amazonaws.com', '');

    if (origin) {
      if (!this.bucketName_) {
        console.warn('S3 bucket name is not provided. Using the bucket name from the CloudFront distribution origin.');
        this.bucketName_ = originBucketName;
      } else if (originBucketName !== this.bucketName_) {
        console.warn(`CloudFront distribution's S3 origin bucket name '${originBucketName}' does not match the provided S3 bucket name '${this.bucketName_}'. Using CloudFront distribution's S3 origin bucket name.`);
        this.bucketName_ = originBucketName;
      }
    }
  }

  /**
   * @summary This method only runs when the CloudFront distribution ID is provided.
   */
  private setCacheBehaviorPathPattern(
    distributionConfig: DistributionConfig,
    cacheBehaviorPathPattern: string,
  ): CacheBehavior {
    const notFoundMessage = `Cache behavior path pattern '${cacheBehaviorPathPattern}' is not included in the CloudFront distribution cache behaviors. Using default Cache Behavior.`;
    const defaultCacheBehavior: CacheBehavior = {
      PathPattern: '*',
      TargetOriginId: this.s3Origin_?.Id,
      ViewerProtocolPolicy: 'allow-all',
    };

    if (distributionConfig.DefaultCacheBehavior) {
      defaultCacheBehavior.TargetOriginId = distributionConfig.DefaultCacheBehavior.TargetOriginId;
      defaultCacheBehavior.ViewerProtocolPolicy = distributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy;
    }

    let cacheBehavior = defaultCacheBehavior;

    if (distributionConfig.CacheBehaviors?.Items?.length) {
      if (cacheBehaviorPathPattern) {
        const foundCacheBehavior = distributionConfig.CacheBehaviors.Items.find((c) => c.PathPattern === cacheBehaviorPathPattern);

        if (!foundCacheBehavior) {
          console.warn(notFoundMessage);
        } else {
          cacheBehavior = foundCacheBehavior;
        }
      }
    } else if (cacheBehaviorPathPattern) {
      console.warn(notFoundMessage);
    }

    if (cacheBehavior.TargetOriginId !== this.s3Origin_?.Id) {
      const targetOrigin = distributionConfig.Origins?.Items?.find((o) => o.Id === cacheBehavior.TargetOriginId);
      console.warn(`Cache behavior target origin '${targetOrigin?.OriginPath}' is not included in the CloudFront distribution origins. Using default Cache Behavior.`);
      cacheBehavior = defaultCacheBehavior;
    }

    return cacheBehavior;
  }

  private getUrlFromKey(key: string, relative = false): string {
    let relativePath = `/${key}`;

    if (this.cacheBehavior_) {
      const originPath = this.s3Origin_?.OriginPath ?? '';
      const pathPattern = this.cacheBehavior_.PathPattern;
      const searchValue = originPath ? new RegExp(`^${originPath}`) : '';

      if (pathPattern === '*') {
        relativePath = relativePath.replace(searchValue, '');
      } else {
        // TODO: Update `relativePath` to comply with provided path pattern
      }
    }

    if (relative) {
      return relativePath;
    }

    return `${this.baseUrl_}${relativePath}`;
  }

  private getKeyFromFile(file): string {
    if (!file) {
      return '';
    }

    let key: string = '';

    if (this.s3Origin_?.OriginPath) {
      const originPath = this.s3Origin_.OriginPath.replace(/^\//, '');
      key += `${originPath}/`;
    }

    key += file.originalname;

    return key;
  }

  private async initAwsGlobals({
    domainName,
    s3OriginPath,
    cacheBehaviorPathPattern,
  }: {
    domainName?: string,
    s3OriginPath?: string,
    cacheBehaviorPathPattern?: string,
  }): Promise<void> {
    if (!this.cloudFrontDistributionId_) {
      return this.setDefaults(s3OriginPath, domainName);
    }

    try {
      this.cloudFrontDistribution_ = await this.getCloudFrontDistribution(this.cloudFrontDistributionId_);
      const distributionConfig = this.cloudFrontDistribution_.DistributionConfig;

      this.s3Origin_ = this.setS3Origin(distributionConfig, s3OriginPath);
      this.validateS3BucketName(this.s3Origin_);
      this.baseUrl_ = this.setBaseUrl(this.cloudFrontDistribution_, domainName);
      this.cacheBehavior_ = this.setCacheBehaviorPathPattern(distributionConfig, cacheBehaviorPathPattern);
    } catch (error) {
      this.setDefaults(s3OriginPath);
    }
  }

  private getPutObjectCommandInput(file, isProtected = false): PutObjectCommandInput {
    return {
      Bucket: this.bucketName_,
      Key: this.getKeyFromFile(file),
      Body: file?.path ? createReadStream(file.path) : new PassThrough(),
      ...this.uploadOptions_,
      ACL: isProtected ? 'private' : this.uploadOptions_.ACL || 'public-read',
    };
  }

  private async uploadFile(file, isProtected = false): Promise<FileServiceUploadResult> {
    const params = this.getPutObjectCommandInput(file, isProtected);
    const data = await this.s3Client_.send(
      new PutObjectCommand(params),
    );

    if (!data) {
      throw new Error('File upload failed');
    }

    await this.invalidateFile(this.getUrlFromKey(params.Key, true));

    return {
      url: this.getUrlFromKey(params.Key),
    };
  }

  private async removeFile(fileKey: string): Promise<void> {
    const data = await this.s3Client_.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName_,
        Key: fileKey,
      }),
    );

    if (!data) {
      throw new Error('File deletion failed');
    }
  }

  private async invalidateFile(path: string): Promise<void> {
    if (!this.cloudFrontDistributionId_ || !path) {
      return;
    }

    try {
      await this.cloudFrontClient_.send(
        new CreateInvalidationCommand({
          DistributionId: this.cloudFrontDistributionId_,
          InvalidationBatch: {
            Paths: {
              Quantity: 1,
              Items: [encodeURI(path)],
            },
            CallerReference: Date.now().toString(),
          },
        }),
      );
    } catch (e) {
      console.warn(`Invalidation failed for path: ${path}`);
    }
  }

  async upload(file): Promise<FileServiceUploadResult> {
    await this.initAwsGlobals({
      domainName: this.domainName_,
      s3OriginPath: this.s3OriginPath_,
      cacheBehaviorPathPattern: this.cacheBehaviorPathPattern_,
    });

    return this.uploadFile(file);
  }

  async uploadProtected(file) {
    await this.initAwsGlobals({
      domainName: this.domainName_,
      s3OriginPath: this.s3OriginPath_,
      cacheBehaviorPathPattern: this.cacheBehaviorPathPattern_,
    });

    return this.uploadFile(file, true);
  }

  async delete(file: DeleteFileType): Promise<void> {
    await this.initAwsGlobals({
      domainName: this.domainName_,
      s3OriginPath: this.s3OriginPath_,
      cacheBehaviorPathPattern: this.cacheBehaviorPathPattern_,
    });
    await this.removeFile(file.fileKey);
  }

  async getUploadStreamDescriptor(
    fileData: UploadStreamDescriptorType,
  ): Promise<FileServiceGetUploadStreamResult> {
    await this.initAwsGlobals({
      domainName: this.domainName_,
      s3OriginPath: this.s3OriginPath_,
      cacheBehaviorPathPattern: this.cacheBehaviorPathPattern_,
    });

    const fileName = `${fileData.name}.${fileData.ext}`;
    const file = { originalname: fileName };
    const params = this.getPutObjectCommandInput(file);

    return {
      writeStream: params.Body,
      promise: this.s3Client_.send(
        new PutObjectCommand(params),
      ),
      url: this.getUrlFromKey(params.Key),
      fileKey: params.Key,
    };
  }

  async getDownloadStream(fileData: GetUploadedFileType): Promise<NodeJS.ReadableStream> {
    await this.initAwsGlobals({
      domainName: this.domainName_,
      s3OriginPath: this.s3OriginPath_,
      cacheBehaviorPathPattern: this.cacheBehaviorPathPattern_,
    });

    const data: GetObjectCommandOutput = await this.s3Client_.send(
      new GetObjectCommand({
        Bucket: this.bucketName_,
        Key: fileData.fileKey,
      }),
    );

    if (!data?.Body) {
      throw new Error('File not found');
    }

    const byteArray = await data.Body.transformToByteArray();

    return Readable.from(byteArray);
  }

  async getPresignedDownloadUrl(fileData: GetUploadedFileType): Promise<string> {
    await this.initAwsGlobals({
      domainName: this.domainName_,
      s3OriginPath: this.s3OriginPath_,
      cacheBehaviorPathPattern: this.cacheBehaviorPathPattern_,
    });

    const fileName = fileData.fileKey.split('/').at(-1);
    const file = { originalname: fileName };
    const params = this.getPutObjectCommandInput(file);
    const command = new GetObjectCommand(params);

    if (!this.cloudFrontDistributionId_) {
      return getS3SignedUrl(this.s3Client_, command, { expiresIn: this.downloadUrlDuration_ });
    }

    const now = new Date();
    const expiresDate = new Date(now.getTime() + this.downloadUrlDuration_ * 1000);

    return getCloudFrontSignedUrl({
      url: this.getUrlFromKey(params.Key),
      keyPairId: this.cloudFrontKeyPairId_,
      dateLessThan: expiresDate.toISOString(),
      privateKey: this.cloudFrontKeyPrivateKey_,
    });
  }
}

export default AwsStorageService;
