import { TransformerContext } from 'graphql-transformer-core';
import { AppSync, Fn } from 'cloudform-types';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';

export const pipelineFunctionName = 'FunctionGetUserData'
export const generateFunction = (ctx: TransformerContext) => {
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: Fn.GetAtt('UserRoleCheckingDataSource', 'Name'),
    RequestMappingTemplate: `
############################################
##      [Start] DynamoDB Get Request      ##
############################################
{
  "version": "${RESOLVER_VERSION_ID}",
  "operation": "GetItem",
  "key": {
    "id": $util.dynamodb.toDynamoDBJson($ctx.stash.userID)
  }
}
############################################
##       [End] DynamoDB Get Request       ##
############################################
`,
    ResponseMappingTemplate: `
############################################
##      [Start] Simple error check        ##
############################################
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type, $ctx.result)
#else
  $util.qr($ctx.stash.put("userData", $ctx.result))
  $util.qr($ctx.stash.put("organisationID", $ctx.stash.userData.currentOrganisationID))
#end
############################################
##       [End] Simple error check         ##
############################################
##  DON'T REMOVE CAUSING EMPTY RESPONSE ERROR
{}
`,
    Name: pipelineFunctionName,
    FunctionVersion: RESOLVER_VERSION_ID
  })

  ctx.setResource(pipelineFunctionName, pipelineFunction);
  ctx.mapResourceToStack('RoleChecking', pipelineFunctionName);
}

export default generateFunction
