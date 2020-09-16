import { TransformerContext } from 'graphql-transformer-core';
import { AppSync, Fn } from 'cloudform-types';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';

export const pipelineFunctionName = 'FunctionCreateInstanceAdminRole';
export const generateFunction = (ctx: TransformerContext) => {
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: Fn.GetAtt('InstanceRoleRoleCheckingDataSource', 'Name'),
    RequestMappingTemplate: `
############################################
##      [Start] DynamoDB Put Request      ##
############################################
{
  "version": "${RESOLVER_VERSION_ID}",
  "operation": "PutItem",
  "key": {
    "instanceID": $util.dynamodb.toDynamoDBJson($ctx.prev.result.id),
    "organisationID": $util.dynamodb.toDynamoDBJson($ctx.stash.userID)
  },
  "attributeValues": {
    "instanceType": $util.dynamodb.toDynamoDBJson($ctx.stash.typeName),
    "organisationID": $util.dynamodb.toDynamoDBJson($ctx.stash.organisationID),
    "role": { "S": "ADMIN_ACCESS" },
    "addedBy": $util.dynamodb.toDynamoDBJson($ctx.stash.userID)
  }
}
############################################
##       [End] DynamoDB Put Request       ##
############################################
`,
    ResponseMappingTemplate: `
############################################
##      [Start] Simple error check        ##
############################################
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type, $ctx.prev.result)
#else
  $util.toJson($ctx.prev.result)
#end
############################################
##       [End] Simple error check         ##
############################################
##  DON'T REMOVE CAUSING EMPTY RESPONSE ERROR
{}
`,
    Name: pipelineFunctionName,
    FunctionVersion: RESOLVER_VERSION_ID,
  });

  ctx.setResource(pipelineFunctionName, pipelineFunction);
  ctx.mapResourceToStack('RoleChecking', pipelineFunctionName);
};

export default generateFunction;
