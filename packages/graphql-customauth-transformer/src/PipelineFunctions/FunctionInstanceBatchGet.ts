import { TransformerContext } from 'graphql-transformer-core';
import { AppSync, Fn } from 'cloudform-types';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';

// TODO: Replace -tylqaqhldbbazmqji7cehkrqhm-dev by the way to get the GraphQL API ID and env from a mapping template

export const pipelineFunctionName = 'FunctionInstanceBatchGet';
export const generateFunction = (ctx: TransformerContext) => {
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: Fn.GetAtt('AllTablesRoleCheckingDataSource', 'Name'),
    RequestMappingTemplate: `
############################################
##   [Start] DynamoDB Batch Get Request   ##
############################################
#if($ctx.stash.instanceIDsToGet.size() > 0)
  #set($formattedKeys = [])
  #set($tableName = "\${ctx.stash.modelName}-tylqaqhldbbazmqji7cehkrqhm-dev")
  
  #foreach($key in $ctx.stash.instanceIDsToGet)
    $util.qr($formattedKeys.add({ "id": { "S": $key } }))
  #end
  
  {
    "version": "${RESOLVER_VERSION_ID}",
    "operation": "BatchGetItem",
    "tables": {
      "$tableName": {
        "keys": $util.toJson($formattedKeys)
      }
    }
  }
#else
  ##  DON'T REMOVE CAUSING EMPTY RESPONSE ERROR
  {}
#end
############################################
##    [End] DynamoDB Batch Get Request    ##
############################################
`,
    ResponseMappingTemplate: `
############################################
##   [Start] DynamoDB Batch Get Response  ##
############################################
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type, $ctx.result)
#else
  ##  Set the data to return
  #set($data = {
    "items": []
  })

  ##  Filtering out eventual null items returned by BatchGetItem
  #set($tableName = "\${ctx.stash.modelName}-tylqaqhldbbazmqji7cehkrqhm-dev")
  #set($array = $util.defaultIfNull($ctx.result.data[$tableName], []))
  #foreach($item in $array)
    #if(!$util.isNull($item))
      $util.qr($data.items.add($item))
    #end
  #end

  ##  Add the nextToken if present
  #if($ctx.stash.nextToken)
    $util.qr($data.put("nextToken", $ctx.stash.nextToken))
  #end

  ##  Return the json stringified data
  $util.toJson($data)
#end
############################################
##    [End] DynamoDB Batch Get Response   ##
############################################
`,
    Name: pipelineFunctionName,
    FunctionVersion: RESOLVER_VERSION_ID,
  });

  ctx.setResource(pipelineFunctionName, pipelineFunction);
  ctx.mapResourceToStack('RoleChecking', pipelineFunctionName);
};
