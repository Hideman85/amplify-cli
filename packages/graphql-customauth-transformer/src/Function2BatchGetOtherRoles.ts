import {TransformerContext} from 'graphql-transformer-core'
import {AppSync, Fn} from 'cloudform-types'
import {ResourceConstants} from 'graphql-transformer-common'
import {RESOLVER_VERSION_ID} from 'graphql-mapping-template'

export const pipelineFunctionName = 'Function2BatchGetOtherRoles'
export const generateFunction = (ctx: TransformerContext) => {
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: 'NONE',
    RequestMappingTemplate: `
############################################
##   [Start] DynamoDB Batch Get Request   ##
############################################
#set($orgUser = $util.defaultIfNull($ctx.stash.organisationUserRole, {}))
#set($teamID = $orgUser.teamID)
{
  "version": "2018-05-29",
  "operation": "BatchGetItem",
  "tables": {
    ############################################
    ##        [Start] Team role fetch         ##
    ############################################
    #if(!$util.isNullOrEmpty($teamID))
      "OrganisationRole": [
        {
          "entityID": $util.dynamodb.toDynamoDBJson($teamID),
          "organisationID": $util.dynamodb.toDynamoDBJson($ctx.stash.organisationID)
        }
      ],
    #end
    ############################################
    ##         [End] Team role fetch          ##
    ############################################


    ############################################
    ##      [Start] Instance roles fetch      ##
    ############################################
    #if(!$util.isNullOrEmpty($ctx.stash.instanceID))
      "InstanceRole": [
        {
          ################################################
          ##          Getting direct user role
          ################################################
          "entityID": $util.dynamodb.toDynamoDBJson($ctx.stash.userID),
          "instanceID": $util.dynamodb.toDynamoDBJson($ctx.stash.instanceID)
        },
        #if(!$util.isNullOrEmpty($teamID))
          {
            ################################################
            ##         Getting direct team role
            ################################################
            "entityID": $util.dynamodb.toDynamoDBJson($teamID),
            "instanceID": $util.dynamodb.toDynamoDBJson($ctx.stash.instanceID)
          },
        #end
        {
          ################################################
          ##       Getting direct organisation role
          ################################################
          "entityID": $util.dynamodb.toDynamoDBJson($ctx.stash.organisationID),
          "instanceID": $util.dynamodb.toDynamoDBJson($ctx.stash.instanceID)
        }
      ]
    #end
    ############################################
    ##      [End] Instance roles fetch        ##
    ############################################
  }
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
  ##########################################################
  ##   Check if we have a organisation role for the Team
  ##########################################################
  #if($ctx.result.data.OrganisationRole && $ctx.result.data.OrganisationRole[0])
    $util.qr($ctx.stash.put("organisationTeamRole", $ctx.result.data.OrganisationRole[0]))
  #end

  ##########################################################
  ##           Iterates and map instance roles
  ##########################################################
  #if($ctx.result.data.InstanceRole)
    #foreach($role in $ctx.result.data.InstanceRole)
      #if($role)
        #if($role.entityID == $ctx.stash.organisationID)
          $util.qr($ctx.stash.put("instanceOrganisationRole", $role))
        #elif($role.entityID == $ctx.stash.userID)
          $util.qr($ctx.stash.put("instanceUserRole", $role))
        #else ## The team role
          $util.qr($ctx.stash.put("instanceTeamRole", $role))
        #end
      #end
    #end
  #end
#end
############################################
##        [End] Simple error check        ##
############################################
`,
    Name: pipelineFunctionName,
    FunctionVersion: RESOLVER_VERSION_ID
  })

  ctx.setResource(pipelineFunctionName, pipelineFunction);
  ctx.mapResourceToStack('RoleChecking', pipelineFunctionName);
}
