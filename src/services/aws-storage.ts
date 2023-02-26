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
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
  protected readonly bucketName_: string;
  protected readonly protocol_: string;
  protected readonly cloudFrontDistributionId_: string;
  protected readonly uploadOptions_: Pick<PutObjectCommandInput, 'ACL' | 'CacheControl' | 'ServerSideEncryption' | 'StorageClass'>;
  protected readonly downloadUrlDuration_: number;
  protected s3Origin_: Origin;
  protected baseUrl_: string;
  protected cacheBehavior_: CacheBehavior;

  protected readonly manager_: EntityManager;
  protected readonly transactionManager_: EntityManager | undefined;

  constructor(container, options) {
    super(container, options);
    console.info('constructor -- options', options);

    const commonAwsConfig = {
      region: options.region,
      credentials: {
        accessKeyId: options.access_key_id,
        secretAccessKey: options.secret_access_key,
      },
    };
    this.s3Client_ = new S3Client(commonAwsConfig);
    this.cloudFrontClient_ = new CloudFrontClient(commonAwsConfig);
    this.cloudFrontDistributionId_ = options.cloud_front_distribution_id;
    this.bucketName_ = options.s3_bucket;
    this.protocol_ = options.use_https ? 'https' : 'http'
    this.uploadOptions_ = options.s3_upload_options || {};
    this.downloadUrlDuration_ = options.download_url_duration;

    this.init({
      domainName: options.domain_name,
      s3Origin: options.s3_origin_path,
      cacheBehaviorPathPattern: options.cloud_front_cache_behavior_path_pattern,
    });
  }

  private async getCloudFrontDistribution(distributionId: string): Promise<Distribution> {
    const response = await this.cloudFrontClient_.send(
      new GetDistributionCommand({
        Id: distributionId,
      })
    );

    if (!response) {
      throw new Error('Could not get distribution config');
    }

    return response.Distribution;
  }

  private setDefaults() {
    this.baseUrl_ = `${this.protocol_}://${this.bucketName_}.s3.amazonaws.com`;
    this.s3Origin_ = null;
    this.cacheBehavior_ = null;
  }

  private setBaseUrl(distribution: Distribution, domainName: string): void {
    let baseUrl = `${this.bucketName_}.s3.amazonaws.com`;
    console.info('setBaseUrl -- distribution', distribution);
    const distributionConfig = distribution.DistributionConfig;
    console.info('setBaseUrl -- distributionConfig', distributionConfig);

    if (distribution.DomainName) {
      baseUrl = distribution.DomainName;
    }

    console.info('setBaseUrl -- domainName', domainName);
    console.info('setBaseUrl -- distributionConfig.Aliases.Items', distributionConfig?.Aliases?.Items);

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

    this.baseUrl_ = `${this.protocol_}://${baseUrl}`;
  }

  /**
   * @summary This method only runs when the CloudFront distribution ID is provided.
   */
  private setS3Origin(distributionConfig: DistributionConfig, s3Origin: string): void {
    const s3Origins = distributionConfig.Origins?.Items?.filter((o) => {
      return o.DomainName.endsWith('.s3.amazonaws.com');
    }) ?? [];
    console.info('setS3Origin -- s3Origin', s3Origin);
    console.info('setS3Origin -- distributionConfig.Origins.Items', distributionConfig.Origins?.Items);
    console.info('setS3Origin -- s3Origins', s3Origins);
    console.info('setS3Origin -- distributionConfig.DefaultCacheBehavior', distributionConfig.DefaultCacheBehavior);
    const defaultCacheBehaviorOriginId = distributionConfig.DefaultCacheBehavior?.TargetOriginId;
    let origin = s3Origins.find((o) => o.Id === defaultCacheBehaviorOriginId) ?? s3Origins[0];
    const notFoundMessage = `S3 origin path '${s3Origin}' is not included in the CloudFront distribution origins. Using default cache behavior S3 origin.`;

    if (s3Origins.length) {
      if (s3Origin) {
        const foundOrigin = s3Origins.find((o) => o.OriginPath === s3Origin);

        if (!foundOrigin) {
          console.warn(notFoundMessage);
        } else {
          origin = foundOrigin;
        }
      }
    } else if (s3Origin) {
      console.warn(notFoundMessage);
    }

    this.s3Origin_ = origin;
  }

  /**
   * @summary This method only runs when the CloudFront distribution ID is provided.
   */
  private setCacheBehaviorPathPattern(
    distributionConfig: DistributionConfig,
    cacheBehaviorPathPattern: string,
  ): void {
    const notFoundMessage = `Cache behavior path pattern '${cacheBehaviorPathPattern}' is not included in the CloudFront distribution cache behaviors. Using default Cache Behavior.`;
    const defaultCacheBehavior: CacheBehavior = {
      PathPattern: '*',
      TargetOriginId: this.s3Origin_?.Id,
      ViewerProtocolPolicy: 'allow-all',
    };

    console.info('setCacheBehaviorPathPattern -- distributionConfig.DefaultCacheBehavior', distributionConfig.DefaultCacheBehavior);

    if (distributionConfig.DefaultCacheBehavior) {
      defaultCacheBehavior.TargetOriginId = distributionConfig.DefaultCacheBehavior.TargetOriginId;
      defaultCacheBehavior.ViewerProtocolPolicy = distributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy;
    }

    let cacheBehavior = defaultCacheBehavior;

    console.info('setCacheBehaviorPathPattern -- distributionConfig.CacheBehaviors.Items', distributionConfig.CacheBehaviors?.Items);
    console.info('setCacheBehaviorPathPattern -- cacheBehaviorPathPattern', cacheBehaviorPathPattern);

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

    console.info('setCacheBehaviorPathPattern -- cacheBehavior', cacheBehavior);
    console.info('setCacheBehaviorPathPattern -- s3Origin_', this.s3Origin_);

    if (cacheBehavior.TargetOriginId !== this.s3Origin_?.Id) {
      const targetOrigin = distributionConfig.Origins?.Items?.find((o) => o.Id === cacheBehavior.TargetOriginId);
      console.warn(`Cache behavior target origin '${targetOrigin?.OriginPath}' is not included in the CloudFront distribution origins. Using default Cache Behavior.`);
      cacheBehavior = defaultCacheBehavior;
    }

    this.cacheBehavior_ = cacheBehavior;
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

  private getKeyFromUrl(url: string): string {
    let relativePath = url.replace(this.baseUrl_, '');

    if (this.cacheBehavior_) {
      const originPath = this.s3Origin_?.OriginPath ?? '';
      const pathPattern = this.cacheBehavior_.PathPattern;

      if (pathPattern === '*') {
        relativePath = `${originPath}${relativePath}`;
      } else {
        // TODO: Update `relativePath` to comply with provided path pattern
      }
    }

    return relativePath.replace(/^\//, '');
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

  private init({
    domainName,
    s3Origin,
    cacheBehaviorPathPattern,
  }: { domainName?: string, s3Origin?: string, cacheBehaviorPathPattern?: string }): void {
    if (!this.cloudFrontDistributionId_) {
      this.setDefaults();

      if (domainName) {
        this.baseUrl_ = `${this.protocol_}://${domainName}`;
      }

      if (s3Origin) {
        this.s3Origin_ = {
          Id: '',
          DomainName: `${this.bucketName_}.s3.amazonaws.com`,
          OriginPath: s3Origin,
        };
      }

      console.info('init -- baseUrl_', this.baseUrl_);
      console.info('init -- s3Origin_', this.s3Origin_);
      console.info('init -- cacheBehavior_', this.cacheBehavior_);

      return;
    }

    this.getCloudFrontDistribution(this.cloudFrontDistributionId_).then((distribution) => {
      this.setBaseUrl(distribution, domainName);
      this.setS3Origin(distribution.DistributionConfig, s3Origin);
      this.setCacheBehaviorPathPattern(distribution.DistributionConfig, cacheBehaviorPathPattern);
      console.info('init -- baseUrl_', this.baseUrl_);
      console.info('init -- s3Origin_', this.s3Origin_);
      console.info('init -- cacheBehavior_', this.cacheBehavior_);
    }).catch((error) => {
      this.setDefaults();

      if (s3Origin) {
        this.s3Origin_ = {
          Id: '',
          DomainName: `${this.bucketName_}.s3.amazonaws.com`,
          OriginPath: s3Origin,
        };
      }

      console.info('init.getCloudFrontDistribution -- error', error);
      console.info('init.getCloudFrontDistribution -- baseUrl_', this.baseUrl_);
      console.info('init.getCloudFrontDistribution -- s3Origin_', this.s3Origin_);
      console.info('init.getCloudFrontDistribution -- cacheBehavior_', this.cacheBehavior_);
    });
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
    console.info('uploadFile -- params', params);
    const data = await this.s3Client_.send(
      new PutObjectCommand(params),
    );
    console.info('uploadFile -- data', data);

    if (!data) {
      throw new Error('File upload failed');
    }

    console.info('uploadFile -- key (relative)', this.getUrlFromKey(params.Key, true));
    console.info('uploadFile -- key', this.getUrlFromKey(params.Key));

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
    if (!this.cloudFrontDistributionId_) {
      return;
    }

    try {
      const data = await this.cloudFrontClient_.send(
        new CreateInvalidationCommand({
          DistributionId: this.cloudFrontDistributionId_,
          InvalidationBatch: {
            Paths: {
              Quantity: 1,
              Items: [path],
            },
            CallerReference: Date.now().toString(),
          },
        }),
      );
      console.info('invalidateFile -- data', data);
    } catch (e) {
      console.info('invalidateFile -- error', e);
      console.warn(`Invalidation failed for path: ${path}`);
    }
  }

  upload(file): Promise<FileServiceUploadResult> {
    console.info('upload -- file', file);
    return this.uploadFile(file);
  }

  uploadProtected(file) {
    return this.uploadFile(file, true);
  }

  async delete(file: DeleteFileType): Promise<void> {
    await this.removeFile(file.fileKey);
  }

  async getUploadStreamDescriptor(
    fileData: UploadStreamDescriptorType,
  ): Promise<FileServiceGetUploadStreamResult> {
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
    const fileName = fileData.fileKey.split('/').at(-1);
    const file = { originalname: fileName };
    const params = this.getPutObjectCommandInput(file);
    const command = new GetObjectCommand(params);

    return getSignedUrl(this.s3Client_, command, { expiresIn: this.downloadUrlDuration_ });
  }
}

export default AwsStorageService;
