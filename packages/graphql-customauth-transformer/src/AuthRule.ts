import Maybe from 'graphql/tsutils/Maybe'

export type RoleKindEnum = 'ORGANISATION_ROLE' | 'ORGANISATION_MEMBER' | 'ORGANISATION_ADMIN' | 'INSTANCE_ROLE'
export type Role = 'VIEWING_ACCESS'  | 'ADMIN_ACCESS' // For both
  | 'COMMENTING_ACCESS' | 'EDITING_ACCESS' // For Instance only
  | 'CREATING_ACCESS' // For Organisation only
export type ActionEnum = 'GET' | 'LIST' | 'CREATE' | 'UPDATE' | 'DELETE' | 'SUBSCRIPTION'
export type ListConfigEnum = 'LIST_BY_INSTANCE_ROLE_LOOKUP' | 'LIST_BY_ORGANISATION_ID'

export interface ListConfig {
  kind: ListConfigEnum;
  // Attributes for kind = LIST_BY_ORGANISATION_ID
  listIndex: String;
  organisationID: String;
}

export interface AuthRuleDirective {
  actions: ActionEnum[];
  kind: RoleKindEnum;
  allowedRoles: Role[];
  instanceField: Maybe<string>;
}

export interface Rule {
  kind: RoleKindEnum;
  allowedRoles: Role[];
  instanceField: Maybe<string>;
}

export interface ListRule extends Rule {
  listConfig: Maybe<ListConfig>;
}

export interface AuthRule {
  get: Maybe<Rule>;
  list: Maybe<ListRule>;
  create: Maybe<Rule>;
  update: Maybe<Rule>;
  delete: Maybe<Rule>;
  subscription: Maybe<Rule>;
}
