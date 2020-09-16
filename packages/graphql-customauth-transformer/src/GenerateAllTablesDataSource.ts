import { TransformerContext } from 'graphql-transformer-core';
import { AppSync, Fn, IAM, IntrinsicFunction, Refs } from 'cloudform-types';
import { ResourceConstants, SyncResourceIDs } from 'graphql-transformer-common';
import md5 from 'md5';
import { Kind } from 'graphql';

const dynamoDBTableName = (typeName: string): IntrinsicFunction => {
  return Fn.If(
    ResourceConstants.CONDITIONS.HasEnvironmentParameter,
    Fn.Join('-', [
      typeName,
      Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
      Fn.Ref(ResourceConstants.PARAMETERS.Env),
    ]),
    Fn.Join('-', [typeName, Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId')]),
  );
};

const roleName = 'BatchIAMRole';
const makeBatchIAMRole = (types: string[], syncConfig: boolean) => {
  const tables = [];
  types.forEach(typeName => {
    tables.push(
      Fn.Sub('arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${tablename}', {
        tablename: dynamoDBTableName(typeName),
      }),
    );
    tables.push(
      Fn.Sub('arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${tablename}/*', {
        tablename: dynamoDBTableName(typeName),
      }),
    );
  });

  return new IAM.Role({
    RoleName: Fn.If(
      ResourceConstants.CONDITIONS.HasEnvironmentParameter,
      Fn.Join('-', [
        roleName.slice(0, 14) + md5(roleName).slice(15, 21), // max of 64. 64-10-26-4-3 = 21
        'role', // 4
        Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'), // 26
        Fn.Ref(ResourceConstants.PARAMETERS.Env), // 10
      ]),
      Fn.Join('-', [
        roleName.slice(0, 24) + md5(roleName).slice(25, 31), // max of 64. 64-26-4-3 = 31
        'role',
        Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
      ]),
    ),
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: 'appsync.amazonaws.com',
          },
          Action: 'sts:AssumeRole',
        },
      ],
    },
    Policies: [
      new IAM.Role.Policy({
        PolicyName: 'DynamoDBAccess',
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: [
                'dynamodb:BatchGetItem',
                'dynamodb:GetItem',
                'dynamodb:Scan',
                'dynamodb:Query',
                'dynamodb:PutItem',
                'dynamodb:DeleteItem',
                'dynamodb:UpdateItem',
              ],
              Resource: [
                ...tables,
                ...(syncConfig
                  ? [
                    Fn.Sub('arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${tablename}', {
                      tablename: Fn.If(
                        ResourceConstants.CONDITIONS.HasEnvironmentParameter,
                        Fn.Join('-', [
                          SyncResourceIDs.syncTableName,
                          Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
                          Fn.Ref(ResourceConstants.PARAMETERS.Env),
                        ]),
                        Fn.Join('-', [
                          SyncResourceIDs.syncTableName,
                          Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
                        ]),
                      ),
                    }),
                    Fn.Sub('arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${tablename}/*', {
                      tablename: Fn.If(
                        ResourceConstants.CONDITIONS.HasEnvironmentParameter,
                        Fn.Join('-', [
                          SyncResourceIDs.syncTableName,
                          Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
                          Fn.Ref(ResourceConstants.PARAMETERS.Env),
                        ]),
                        Fn.Join('-', [
                          SyncResourceIDs.syncTableName,
                          Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
                        ]),
                      ),
                    }),
                  ]
                  : []),
              ],
            },
          ],
        },
      }),
      // ...(syncConfig && SyncUtils.isLambdaSyncConfig(syncConfig)
      //   ? [SyncUtils.createSyncLambdaIAMPolicy(syncConfig.LambdaConflictHandler)]
      //   : []),
    ],
  });
};

const genAllTableDataSource = (ctx: TransformerContext, syncConfig: boolean) => {
  const types = [];
  Object.values(ctx.nodeMap).forEach(node => {
    if (node.kind === Kind.OBJECT_TYPE_DEFINITION && node.directives.find(dir => dir.name.value === 'model')) {
      types.push(node.name.value);
    }
  });

  const batchIAMRole = makeBatchIAMRole(types, syncConfig);
  ctx.setResource(roleName, batchIAMRole);
  ctx.mapResourceToStack('RoleChecking', roleName);

  ['AllTables', 'User', 'OrganisationRole', 'InstanceRole'].forEach(tableName => {
    const dataSourceName = `${tableName}RoleCheckingDataSource`;
    const dataSource = new AppSync.DataSource({
      ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
      Name: dataSourceName,
      Type: 'AMAZON_DYNAMODB',
      ServiceRoleArn: Fn.GetAtt(roleName, 'Arn'),
      DynamoDBConfig: {
        AwsRegion: Refs.Region,
        TableName: Fn.If(
          ResourceConstants.CONDITIONS.HasEnvironmentParameter,
          Fn.Join('-', [
            tableName,
            Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
            Fn.Ref(ResourceConstants.PARAMETERS.Env),
          ]),
          Fn.Join('-', [
            tableName,
            Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
          ]),
        ),
      },
    }).dependsOn([roleName]);
    ctx.setResource(dataSourceName, dataSource);
    ctx.mapResourceToStack('RoleChecking', dataSourceName);
  });
};

export default genAllTableDataSource;
