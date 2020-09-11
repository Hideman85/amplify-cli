import Resolver, { PipelineConfig } from 'cloudform-types/types/appSync/resolver';
import { ListRule, Rule } from '../AuthRule';
import { TransformerContext } from 'graphql-transformer-core';
import { Fn } from 'cloudform-types';
import { pipelineFunctionName as getUserDataFunc } from '../PipelineFunctions/FunctionGetUserData';
import { pipelineFunctionName as getUserOrganisationRoleFunc } from '../PipelineFunctions/FunctionGetUserOrganisationRole';
import { pipelineFunctionName as instanceLookupFunc } from '../PipelineFunctions/FunctionInstanceRolesLookup';
import { pipelineFunctionName as instanceBatchGetFunc } from '../PipelineFunctions/FunctionInstanceBatchGet';
import { ObjectTypeDefinitionNode } from 'graphql';
import Maybe from 'graphql/tsutils/Maybe';

export const converter = (
  ctx: TransformerContext,
  resolverResourceId: string,
  resolver: Resolver,
  rule: Maybe<ListRule>,
  parent: ObjectTypeDefinitionNode | null,
) => {
  const before = `
############################################
##      [Start] Stashing needed stuff     ##
############################################
#set($ctx.stash = {}) ##  Prefer to empty the stash first looks like it is kept from one call to one other
$util.qr($ctx.stash.put("modelName", "${parent.name.value}"))
$util.qr($ctx.stash.put("userID", $ctx.identity.sub))
$util.qr($ctx.stash.put("roles", ${JSON.stringify(rule.allowedRoles)}))
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
      Fn.Ref(`${instanceLookupFunc}Param`), //  First time for the current selected organisationID
      Fn.Ref(`${instanceLookupFunc}Param`), //  Second time for the marker __EVERYONE__
      Fn.Ref(`${instanceBatchGetFunc}Param`),
    ],
  });

  //  TODO: Remove this once AppSync support both PIPELINE and SyncConfig
  resolver.Properties.DataSourceName = undefined;
  (resolver.Properties as any).SyncConfig = undefined;

  //  Save back the resolver
  ctx.setResource(resolverResourceId, resolver);
};
