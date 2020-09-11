import { AppSync, Fn } from 'cloudform-types';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';
import Resolver, { PipelineConfig } from 'cloudform-types/types/appSync/resolver';
import { pipelineFunctionName as getUserDataFunc } from '../PipelineFunctions/FunctionGetUserData';
import { pipelineFunctionName as getUserOrganisationRoleFunc } from '../PipelineFunctions/FunctionGetUserOrganisationRole';
import { pipelineFunctionName as getOtherRolesFunc } from '../PipelineFunctions/FunctionBatchGetOtherRoles';
import { TransformerContext } from 'graphql-transformer-core';
import { ObjectTypeDefinitionNode } from 'graphql';

export const converter = (
  ctx: TransformerContext,
  parent: ObjectTypeDefinitionNode,
  resourceId: string,
  resolver: Resolver,
  instanceID: string = 'id',
) => {
  const before = `
############################################
##      [Start] Stashing needed stuff     ##
############################################
#set($ctx.stash = {}) ##  Prefer to empty the stash first looks like it is kept from one call to one other
${instanceID ? `$util.qr($ctx.stash.put("instanceID", $ctx.args.input.${instanceID}))` : '## No instanceID set'}
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
  //  Define and assemble pipeline function
  const pipelineFunctionID = `${resourceId}PipelineFunction`;
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: resolver.Properties.DataSourceName,
    RequestMappingTemplate: resolver.Properties.RequestMappingTemplate,
    ResponseMappingTemplate: resolver.Properties.ResponseMappingTemplate,
    Name: pipelineFunctionID,
    FunctionVersion: RESOLVER_VERSION_ID,
  });

  //  Map the new resource
  ctx.setResource(pipelineFunctionID, pipelineFunction);
  ctx.mapResourceToStack(parent.name.value, pipelineFunctionID);

  //  Rewrite the resolver into pipeline resolver
  resolver.Properties.RequestMappingTemplate = before;
  resolver.Properties.ResponseMappingTemplate = after;
  resolver.Properties.Kind = 'PIPELINE';
  resolver.Properties.PipelineConfig = new PipelineConfig({
    Functions: [
      Fn.Ref(`${getUserDataFunc}Param`),
      Fn.Ref(`${getUserOrganisationRoleFunc}Param`),
      Fn.Ref(`${getOtherRolesFunc}Param`),
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
  ctx.setResource(resourceId, resolver);
}
