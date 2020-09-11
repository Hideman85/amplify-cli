import { Rule } from './AuthRule';

const genRoleCheckMappingTemplate = (rule: Rule, modelName: string) => {
  if (rule.kind === 'INSTANCE_ROLE') {
    return `
############################################
##          [Start] Role check            ##
############################################
#set($allowedRoles = ${JSON.stringify(rule.allowedRoles)})
#set($role = null)

##  Finding the role to check
#if($ctx.stash.instanceUserRole)
  #set($role = $ctx.stash.instanceUserRole.role)
#elseif($ctx.stash.instanceTeamRole)
  #set($role = $ctx.stash.instanceTeamRole.role)
#elseif($ctx.stash.instanceOrganisationRole)
  #set($role = $ctx.stash.instanceOrganisationRole.role)
#end

##  Checking the role
#if(!$allowedRoles.contains($role))
  $util.unauthorized()
#end
############################################
##           [End] Role check             ##
############################################
`;
  } else if (rule.kind === 'ORGANISATION_ROLE') {
    return `
############################################
##          [Start] Role check            ##
############################################
#set($allowedRoles = ${JSON.stringify(rule.allowedRoles)})
#set($role = null)

##  Finding the role to check
#if($ctx.stash.organisationUserRole)
  #set($role = $ctx.stash.organisationUserRole.${modelName.toLowerCase()}Role)
#elseif($ctx.stash.organisationTeamRole)
  #set($role = $ctx.stash.organisationTeamRole.${modelName.toLowerCase()}Role)
#end

##  Checking the role
#if(!$allowedRoles.contains($role))
  $util.unauthorized()
#end
############################################
##           [End] Role check             ##
############################################
`;
  } else {
    return `
############################################
##          [Start] Role check            ##
############################################

##  Checking the role
#if(!$ctx.stash.organisationUserRole ${rule.kind === 'ORGANISATION_ADMIN' ? `|| $ctx.stash.organisationUserRole.team != '_admin'` : ''})
  $util.unauthorized()
#end
############################################
##           [End] Role check             ##
############################################
`;
  }
}

export default genRoleCheckMappingTemplate
