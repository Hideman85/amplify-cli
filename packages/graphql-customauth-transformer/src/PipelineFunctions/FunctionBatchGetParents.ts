import { TransformerContext } from 'graphql-transformer-core';
import { AppSync, Fn } from 'cloudform-types';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';

export const pipelineFunctionName = 'FunctionBatchGetParents';
export const generateFunction = (ctx: TransformerContext) => {
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: Fn.GetAtt('AllTablesRoleCheckingDataSource', 'Name'),
    RequestMappingTemplate: `
############################################
##   [Start] DynamoDB Batch Get Request   ##
############################################
{
  "version": "2018-05-29",
  "operation": "BatchGetItem",
  "tables": $util.toJson($ctx.stash.transitiveBatchGet)
}
############################################
##    [End] DynamoDB Batch Get Request    ##
############################################
`,
    ResponseMappingTemplate: `
############################################
##       [Start] Simple error check       ##
############################################
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type, $ctx.result)
#else
  #set($results = {})
  #foreach($entry in $ctx.result.data.entrySet())
    #if($ctx.result.data[$entry.key][0])
      $util.qr($results.put($ctx.result.data[$entry.key][0].id, $ctx.result.data[$entry.key][0]))
    #else
      $util.error(
        "Failed to verify the parents existence for the transitivity constraint",
        "TransitivityCheckError",
        $ctx.args.input,
        {
          "id": $id,
          "transitivity": $ctx.stash.transitivityModel,
          "missingKeys": $ctx.result.unprocessedKeys
        }
      )
    #end
  #end
  $util.qr($ctx.stash.put("data", $results))
#end
############################################
##        [End] Simple error check        ##
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
