import Maybe from 'graphql/tsutils/Maybe'

export type RoleKindEnum = 'ORGANISATION_ROLE' | 'INSTANCE_ROLE'
export type OrganisationRoleEnum = 'VIEWING_ACCESS' | 'CREATING_ACCESS' | 'ADMIN_ACCESS'
export type InstanceRoleEnum = 'VIEWING_ACCESS' | 'COMMENTING_ACCESS' | 'EDITING_ACCESS'
export type Role = OrganisationRoleEnum | InstanceRoleEnum
export type ActionEnum = 'GET' | 'LIST' | 'CREATE' | 'UPDATE' | 'DELETE' | 'SUBSCRIPTION'
export interface AuthRuleDirective {
  action: ActionEnum;
  kind: RoleKindEnum;
  allowedRoles: Role[];
}
export interface Rule {
  kind: RoleKindEnum;
  allowedRoles: Role[];
}
export interface AuthRule {
  get: Maybe<Rule>;
  list: Maybe<Rule>;
  create: Maybe<Rule>;
  update: Maybe<Rule>;
  delete: Maybe<Rule>;
  subscription: Maybe<Rule>;
}
