import { TransformerContext } from 'graphql-transformer-core';
import { SubModelConfig } from '../AuthRule';
import { AppSync, Fn } from 'cloudform-types';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';
import { pipelineFunctionName as getUserDataFunc } from '../PipelineFunctions/FunctionGetUserData';
import { pipelineFunctionName as getUserOrganisationRoleFunc } from '../PipelineFunctions/FunctionGetUserOrganisationRole';
import { pipelineFunctionName as getOtherRolesFunc } from '../PipelineFunctions/FunctionBatchGetOtherRoles';
import { pipelineFunctionName as getParentsFunc } from '../PipelineFunctions/FunctionBatchGetParents';
import { Model } from '../ModelCustomAuthTransformer';
import Resolver, { PipelineConfig } from 'cloudform-types/types/appSync/resolver';
import { ObjectTypeDefinitionNode } from 'graphql';

export interface TransitivityModel {
  types: string[];
  child?: TransitivityModel;
}

export const resolveSubModelTransitivity = (
  def: ObjectTypeDefinitionNode,
  subModel: SubModelConfig,
  modelsProceed: { [key: string]: Model },
) => {
  let currentModelConfig = subModel;
  let transitivityModel: TransitivityModel = {
    types: [def.name.value],
  };

  while (currentModelConfig) {
    if (currentModelConfig.kind === 'CONDITIONALLY_TRANSITIVE') {
      transitivityModel = {
        types: [],
        child: transitivityModel,
      };
    }
    transitivityModel.types = [currentModelConfig.parentType, ...transitivityModel.types];
    const parent = modelsProceed[currentModelConfig.parentType];
    currentModelConfig = parent.subModel;
  }

  return transitivityModel;
};

export const transformToTransitivePipeline = (
  ctx: TransformerContext,
  def: ObjectTypeDefinitionNode,
  resourceId: string,
  resolver: Resolver,
  subModel: SubModelConfig,
  modelsProceed: { [key: string]: Model },
) => {
  const transitivityModel = resolveSubModelTransitivity(def, subModel, modelsProceed);

// TODO: Replace -tylqaqhldbbazmqji7cehkrqhm-dev by the way to get the GraphQL API ID and env from a mapping template

  const before = `
############################################
##      [Start] Stashing needed stuff     ##
############################################
#set($ctx.stash = {}) ##  Prefer to empty the stash first looks like it is kept from one call to one other
$util.qr($ctx.stash.put("userID", $ctx.identity.sub))
$util.qr($ctx.stash.put("transitivityModel", ${JSON.stringify(transitivityModel, null, 2)}))

##  Defining the macro for the error
#macro(makeError)
  $util.error(
    "Input '${def.name.value}' failed to satisfy the transitivity constraint",
    "TransitivityCheckError",
    $ctx.args.input,
    { "id": $id, "transitivity": $ctx.stash.transitivityModel }
  )
#end

##  Verifying ids if it's following the transitivity
#set($id = $util.defaultIfNull($ctx.args.input, $ctx.args).id)
#if($util.isNullOrBlank($id))
  #makeError()
#else
  #set($ids = $id.split("[:]"))
  #set($tr = $ctx.stash.transitivityModel)
  #set($isGood = false)
  
  ##  Defining good state macro
  #macro(makeGood)
    #set($isGood = true)
  #end
  
  ##  Defining recursive macro for checking the ID
  #macro(checkId $idInd $trInd)
    ##  If we found the type
    #if($ids[$idInd].contains($tr.types[$trInd]))
      ##  If found last one return true
      #if($idInd === $ids.size() - 1)
        ##  If we are at the end of the chaining we can resolve
        #if($trInd === $tr.types.size() - 1 && !$tr.child)
          #makeGood()
        ##  If there is missing parents throw error
        #else
          #makeError()
        #end
      ##  Else if we are at the end of the types
      #elseif($trInd === $tr.types.size() - 1)
        ##  If child set and recurse
        #if($tr.child)
          #set($tr = $tr.child)
          #checkId($idInd + 1, 0)
        ##  Else we are in error
        #else
          #makeError()
        #end
      ##  Else just forward
      #else
        #checkId($idInd + 1, $trInd + 1)
      #end
    ##  Or if not found yet
    #else
      ##  Else if we are at the end of the types
      #if($trInd === $tr.types.size() - 1)
        ##  If child set and recurse
        #if($tr.child)
          #set($tr = $tr.child)
          #checkId($idInd, 0)
        ##  Else we are in error
        #else
          #makeError()
        #end
      ##  Else just forward
      #else
        #checkId($idInd, $trInd + 1)
      #end
    #end
  #end
  
  ##  We just need to call the macro
  #checkId(0, 0)
  
  ##  If it's good build the batch get request for testing the existence of all parents
  #if($isGood)
    $util.qr($ctx.stash.put("instanceID", $ids[0])
    #set($idFull = "")
    #set($tables = {})
    #foreach($idTmp in $ids)
      #set($tableName = $idTmp.split("[-]")[0])
      #if($util.isNullOrEmpty($idFull))
        #set($idFull = $idTmp)
      #else
        #set($idFull = "\${$idFull}:\${$idTmp}")
      #end

      ##  We don't want to check this instance but only if parent exists
      ##  We will apply the action on this instance in a pipeline function
      #if($idFull !== $idTmp)
        $utils.qr($tables.put("\${$tableName}-tylqaqhldbbazmqji7cehkrqhm-dev", {
          "keys": [{
            "id": { "S": $idFull }
          }]
        })
      #end
    #end
    $util.qr($ctx.stash.put("transitiveBatchGet", $tables))
  #end
#end
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
  ctx.mapResourceToStack('TransitiveModel', pipelineFunctionID);

  //  Rewrite the resolver into pipeline resolver
  resolver.Properties.RequestMappingTemplate = before;
  resolver.Properties.ResponseMappingTemplate = after;
  resolver.Properties.Kind = 'PIPELINE';
  resolver.Properties.PipelineConfig = new PipelineConfig({
    Functions: [
      Fn.Ref(`${getUserDataFunc}Param`),
      Fn.Ref(`${getUserOrganisationRoleFunc}Param`),
      Fn.Ref(`${getParentsFunc}Param`),
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
  //  Due to dependencies we need to move it in the TransitiveModel stack
  ctx.mapResourceToStack('TransitiveModel', resourceId);
};
