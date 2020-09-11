import Resolver, { PipelineConfig } from 'cloudform-types/types/appSync/resolver';
import { ListRule, Rule } from '../AuthRule';
import { TransformerContext } from 'graphql-transformer-core';
import { Fn } from 'cloudform-types';
import { pipelineFunctionName as getUserDataFunc } from '../PipelineFunctions/FunctionGetUserData';
import { pipelineFunctionName as getUserOrganisationRoleFunc } from '../PipelineFunctions/FunctionGetUserOrganisationRole';
import { ObjectTypeDefinitionNode } from 'graphql';
import Maybe from 'graphql/tsutils/Maybe';
import { AppSync } from 'cloudform-types/types/appSync/index.namespace';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';

export const converter = (
  ctx: TransformerContext,
  resolverResourceId: string,
  resolver: Resolver,
  rule: Maybe<ListRule>,
  parent: ObjectTypeDefinitionNode | null,
) => {
  const pipelineFunctionID = `${parent.name.value}ListPipelineFunction`;
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: resolver.Properties.DataSourceName,
    RequestMappingTemplate: `
############################################
##    [Start] Query by organisationID     ##
############################################
{
  "version": "${RESOLVER_VERSION_ID}",
  "operation": "Query",
  ${rule.listConfig.listIndex ? `"index": "${rule.listConfig.listIndex}",` : ''}
  "query": {
    "expression": "#pk = :pk",
    "expressionNames" : {
      "#pk": "${rule.listConfig.organisationID}"
    },
    "expressionValues": $util.dynamodb.toMapValuesJson({
      ":organisationID": $ctx.stash.organisationID
    })
  },
  "filter": $util.toJson($filter)
##  Others attributes
##  "nextToken": "a pagination token",
##  "scanIndexForward": true,
}
############################################
##     [End] Query by organisationID      ##
############################################
`,
    ResponseMappingTemplate: resolver.Properties.ResponseMappingTemplate,
    Name: pipelineFunctionID,
    FunctionVersion: RESOLVER_VERSION_ID,
  });
  ctx.setResource(pipelineFunctionID, pipelineFunction);
  ctx.mapResourceToStack(parent.name.value, pipelineFunctionID);


  const before = `
############################################
##      [Start] Stashing needed stuff     ##
############################################
#set($ctx.stash = {}) ##  Prefer to empty the stash first looks like it is kept from one call to one other
$util.qr($ctx.stash.put("userID", $ctx.identity.sub))
############################################
##       [End] Stashing needed stuff      ##
############################################
##  DON'T REMOVE CAUSING EMPTY RESPONSE ERROR
{}
`;
  const after = `
############################################
##      [Start] Simple error check        ##
############################################
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type, $ctx.error.data, $ctx.error.errorInfo)
#else
  $util.toJson($ctx.result)
#end
############################################
##       [End] Simple error check         ##
############################################
`;
  //  Rewrite the resolver into pipeline resolver
  resolver.Properties.RequestMappingTemplate = before;
  resolver.Properties.ResponseMappingTemplate = after;
  resolver.Properties.Kind = 'PIPELINE';
  resolver.Properties.PipelineConfig = new PipelineConfig({
    Functions: [
      Fn.Ref(`${getUserDataFunc}Param`),
      Fn.Ref(`${getUserOrganisationRoleFunc}Param`),
      Fn.GetAtt(pipelineFunctionID, 'FunctionId'),
    ],
  });

  //  The resolver need to wait the creation of the pipeline function
  if (typeof resolver.DependsOn === 'string') {
    resolver.DependsOn = [resolver.DependsOn];
  } else if (!Array.isArray(resolver.DependsOn)) {
    resolver.DependsOn = [];
  }
  resolver.DependsOn.push(pipelineFunctionID);

  //  TODO: Remove this once AppSync support both PIPELINE and SyncConfig
  resolver.Properties.DataSourceName = undefined;
  (resolver.Properties as any).SyncConfig = undefined;

  //  Save back the resolver
  ctx.setResource(resolverResourceId, resolver);
};
