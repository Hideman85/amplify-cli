export class ResourceConstants {
  public static NONE = 'NONE';

  public static DEFAULT_PAGE_LIMIT = 100;
  public static DEFAULT_SYNC_QUERY_PAGE_LIMIT = 100;
  public static DEFAULT_SEARCHABLE_PAGE_LIMIT = 100;

  public static readonly RESOURCES = {
    // AppSync
    GraphQLAPILogicalID: 'GraphQLAPI',
    GraphQLSchemaLogicalID: 'GraphQLSchema',
    APIKeyLogicalID: 'GraphQLAPIKey',
    AuthRolePolicy: 'AuthRolePolicy',
    UnauthRolePolicy: 'UnauthRolePolicy',

    // Elasticsearch
    ElasticsearchAccessIAMRoleLogicalID: 'ElasticSearchAccessIAMRole',
    ElasticsearchDomainLogicalID: 'ElasticSearchDomain',
    ElasticsearchStreamingLambdaIAMRoleLogicalID: 'ElasticSearchStreamingLambdaIAMRole',
    ElasticsearchStreamingLambdaFunctionLogicalID: 'ElasticSearchStreamingLambdaFunction',
    ElasticsearchDataSourceLogicalID: 'ElasticSearchDataSource',

    // Local. Try not to collide with model data sources.
    NoneDataSource: 'NoneDataSource',

    // Auth
    AuthCognitoUserPoolLogicalID: 'AuthCognitoUserPool',
    AuthCognitoUserPoolNativeClientLogicalID: 'AuthCognitoUserPoolNativeClient',
    AuthCognitoUserPoolJSClientLogicalID: 'AuthCognitoUserPoolJSClient',
  };
  public static PARAMETERS = {
    // cli
    Env: 'env',
    S3DeploymentBucket: 'S3DeploymentBucket',
    S3DeploymentRootKey: 'S3DeploymentRootKey',

    // AppSync
    AppSyncApiName: 'AppSyncApiName',
    AppSyncApiId: 'AppSyncApiId',
    CreateAPIKey: 'CreateAPIKey',
    AuthRoleName: 'authRoleName',
    UnauthRoleName: 'unauthRoleName',
    APIKeyExpirationEpoch: 'APIKeyExpirationEpoch',

    // DynamoDB
    DynamoDBBillingMode: 'DynamoDBBillingMode',
    DynamoDBModelTableReadIOPS: 'DynamoDBModelTableReadIOPS',
    DynamoDBModelTableWriteIOPS: 'DynamoDBModelTableWriteIOPS',
    DynamoDBEnablePointInTimeRecovery: 'DynamoDBEnablePointInTimeRecovery',
    DynamoDBEnableServerSideEncryption: 'DynamoDBEnableServerSideEncryption',

    // Elasticsearch
    ElasticsearchAccessIAMRoleName: 'ElasticSearchAccessIAMRoleName',
    ElasticsearchDebugStreamingLambda: 'ElasticSearchDebugStreamingLambda',
    ElasticsearchStreamingIAMRoleName: 'ElasticSearchStreamingIAMRoleName',
    ElasticsearchStreamingFunctionName: 'ElasticSearchStreamingFunctionName',
    ElasticsearchInstanceCount: 'ElasticSearchInstanceCount',
    ElasticsearchInstanceType: 'ElasticSearchInstanceType',
    ElasticsearchEBSVolumeGB: 'ElasticSearchEBSVolumeGB',
    ElasticsearchStreamingLambdaHandlerName: 'ElasticSearchStreamingLambdaHandlerName',
    ElasticsearchStreamingLambdaRuntime: 'ElasticSearchStreamingLambdaRuntime',

    // Auth
    AuthCognitoUserPoolId: 'AuthCognitoUserPoolId',
  };
  public static MAPPINGS = {};
  public static CONDITIONS = {
    // Environment
    HasEnvironmentParameter: 'HasEnvironmentParameter',

    // DynamoDB
    ShouldUsePayPerRequestBilling: 'ShouldUsePayPerRequestBilling',
    ShouldUsePointInTimeRecovery: 'ShouldUsePointInTimeRecovery',
    ShouldUseServerSideEncryption: 'ShouldUseServerSideEncryption',

    // Auth
    ShouldCreateAPIKey: 'ShouldCreateAPIKey',
    APIKeyExpirationEpochIsPositive: 'APIKeyExpirationEpochIsPositive',
  };
  public static OUTPUTS = {
    // AppSync
    GraphQLAPIEndpointOutput: 'GraphQLAPIEndpointOutput',
    GraphQLAPIApiKeyOutput: 'GraphQLAPIKeyOutput',
    GraphQLAPIIdOutput: 'GraphQLAPIIdOutput',

    // Elasticsearch
    ElasticsearchStreamingLambdaIAMRoleArn: 'ElasticsearchStreamingLambdaIAMRoleArn',
    ElasticsearchAccessIAMRoleArn: 'ElasticsearchAccessIAMRoleArn',
    ElasticsearchDomainArn: 'ElasticsearchDomainArn',
    ElasticsearchDomainEndpoint: 'ElasticsearchDomainEndpoint',

    // Auth
    AuthCognitoUserPoolIdOutput: 'AuthCognitoUserPoolIdOutput',
    AuthCognitoUserPoolNativeClientOutput: 'AuthCognitoUserPoolNativeClientId',
    AuthCognitoUserPoolJSClientOutput: 'AuthCognitoUserPoolJSClientId',
  };
  public static METADATA = {};

  public static readonly SNIPPETS = {
    AuthCondition: 'authCondition',
    AuthMode: 'authMode',
    VersionedCondition: 'versionedCondition',
    ModelObjectKey: 'modelObjectKey',
    DynamoDBNameOverrideMap: 'dynamodbNameOverrideMap',
    ModelQueryExpression: 'modelQueryExpression',
    ModelQueryIndex: 'modelQueryIndex',
    IsDynamicGroupAuthorizedVariable: 'isDynamicGroupAuthorized',
    IsLocalDynamicGroupAuthorizedVariable: 'isLocalDynamicGroupAuthorized',
    IsStaticGroupAuthorizedVariable: 'isStaticGroupAuthorized',
    IsOwnerAuthorizedVariable: 'isOwnerAuthorized',
    IsLocalOwnerAuthorizedVariable: 'isLocalOwnerAuthorized',
  };
}
