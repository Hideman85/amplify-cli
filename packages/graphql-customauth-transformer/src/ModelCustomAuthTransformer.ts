//  TS Types imports
import Maybe from 'graphql/tsutils/Maybe';
import { ArgumentNode, DirectiveNode, ObjectTypeDefinitionNode, valueFromASTUntyped } from 'graphql';
import { AuthRule, AuthRuleDirective, ListConfig, ListRule, Rule } from './AuthRule';
import { ModelDirectiveConfiguration, ModelDirectiveOperationType, ModelSubscriptionLevel } from './ModelDirectiveConfiguration';

//  Libs imports
import { gql, InvalidDirectiveError, Transformer, TransformerContext } from 'graphql-transformer-core';
import { ResolverResourceIDs, ResourceConstants } from 'graphql-transformer-common';
import { print, raw, RESOLVER_VERSION_ID } from 'graphql-mapping-template';
import { AppSync, CloudFormation, Fn, Template } from 'cloudform-types';
import Resolver from 'cloudform-types/types/appSync/resolver';

//  Pipeline functions imports
import { generateFunction as genGetUserData, pipelineFunctionName as getUserDataFunc } from './PipelineFunctions/FunctionGetUserData';
import {
  generateFunction as genGetUserOrganisationRole,
  pipelineFunctionName as getUserOrganisationRoleFunc,
} from './PipelineFunctions/FunctionGetUserOrganisationRole';
import {
  generateFunction as genGetOtherRoles,
  pipelineFunctionName as getOtherRolesFunc,
} from './PipelineFunctions/FunctionBatchGetOtherRoles';
import {
  generateFunction as genInstanceLookup,
  pipelineFunctionName as instanceLookupFunc,
} from './PipelineFunctions/FunctionInstanceRolesLookup';
import {
  generateFunction as genInstanceBatchGet,
  pipelineFunctionName as instanceBatchGetFunc,
} from './PipelineFunctions/FunctionInstanceBatchGet';

//  All tables DataSource
import genAllTableDataSource from './GenerateAllTablesDataSource';

//  Resolver converters
import { converter as convertListToInstanceRoleLookup } from './ResolverTransformers/ListByInstanceRoleLookup';
import { converter as convertListToOrganisationIDLookup } from './ResolverTransformers/ListByOrganisationID';
import { converter as convertWithRoleChecking } from './ResolverTransformers/SingleActionRoleCheck';

//  Mapping template generator
import genRoleCheckMappingTemplate from './GenRoleCheckMappingTemplate';


export class ModelCustomAuthTransformer extends Transformer {
  private needPipelineFunctions: boolean = false;

  constructor() {
    super(
      'ModelCustomAuthTransformer',
      gql`
        directive @CustomAuth(rules: [Rule_!]!, listConfig: ListConfig_) on OBJECT
        enum RoleKindEnum_ {
          ORGANISATION_ROLE
          ORGANISATION_MEMBER
          ORGANISATION_ADMIN
          INSTANCE_ROLE
        }
        enum RoleEnum_ {
          # Roles both Instance & Organisation
          VIEWING_ACCESS
          ADMIN_ACCESS
          # Roles for Instance only
          COMMENTING_ACCESS
          EDITING_ACCESS
          # Role for Organisation only
          CREATING_ACCESS
        }
        enum ActionEnum_ {
          GET
          LIST
          CREATE
          UPDATE
          DELETE
          SUBSCRIPTION
        }
        input Rule_ {
          actions: [ActionEnum_!]!
          kind: RoleKindEnum_!
          allowedRoles: [RoleEnum_!]!
          instanceField: String
        }
        enum ListConfigKind_ {
          LIST_BY_INSTANCE_ROLE_LOOKUP
          LIST_BY_ORGANISATION_ID
        }
        input ListConfig_ {
          kind: ListConfigKind_!
          # Attributes for kind = LIST_BY_ORGANISATION_ID
          listIndex: String
          organisationID: String
        }
      `,
    );
  }

  public after = (ctx: TransformerContext): void => {
    if (this.needPipelineFunctions) {
      genGetUserData(ctx);
      genGetUserOrganisationRole(ctx);
      genGetOtherRoles(ctx);
      genInstanceLookup(ctx);
      genInstanceBatchGet(ctx);
      genAllTableDataSource(ctx, true);
    }
  };


  public stack = (stackName: string, stackResource: CloudFormation.Stack, stackTemplate: Template) => {
    const functions = [
      getUserDataFunc,
      getUserOrganisationRoleFunc, getOtherRolesFunc,
      instanceLookupFunc, instanceBatchGetFunc
    ];

    if (stackName === 'RoleChecking') {
      //  Exports needed variables
      functions.forEach(output => {
        stackTemplate.Outputs[`${output}Output`] = {
          Value: Fn.GetAtt(output, 'FunctionId'),
        };
      });
    } else {
      //  Add parameters
      functions.forEach(output => {
        stackTemplate.Parameters[`${output}Param`] = { Type: 'String' };
        stackResource.Properties.Parameters[`${output}Param`] = Fn.GetAtt(
          'RoleChecking',
          `Outputs.${output}Output`,
        );
      });
    }
  };

  public object = (def: ObjectTypeDefinitionNode, directive: DirectiveNode, ctx: TransformerContext): void => {
    const modelDirective = def.directives.find(dir => dir.name.value === 'model');
    if (!modelDirective) {
      throw new InvalidDirectiveError('Types annotated with @CustomAuth must also be annotated with @model.');
    }

    // check if searchable is enabled on the type
    const searchableDirective = def.directives.find(dir => dir.name.value === 'searchable');

    // Get and validate the auth rules.
    const rules = this.getAuthRulesFromDirective(directive);

    // Retrieve the configuration options for the related @model directive
    const modelConfiguration = new ModelDirectiveConfiguration(modelDirective, def);

    // For each operation evaluate the rules and apply the changes to the relevant resolver.
    ['Get', 'Create', 'Update', 'Delete'].forEach(action => this.protectSingleItemAction(
      ctx,
      ResolverResourceIDs[`DynamoDB${action}ResolverResourceID`](def.name.value),
      rules[action.toLowerCase()],
      def,
    ));

    // Protect the list query
    this.protectListQuery(
      ctx,
      ResolverResourceIDs.DynamoDBListResolverResourceID(def.name.value),
      rules.list,
      def,
    );

    // Protect sync query if model is sync enabled
    if (this.isSyncEnabled(ctx, def.name.value)) {
      this.protectSyncQuery(ctx, def, ResolverResourceIDs.SyncResolverResourceID(def.name.value), rules.list);
    }

    // Protect search query if @searchable is enabled
    if (searchableDirective) {
      throw new Error('@searchable with @CustomAuth Not implemented yet!');
      // this.protectSearchQuery(ctx, def, ResolverResourceIDs.ElasticsearchSearchResolverResourceID(def.name.value), rules.list);
    }

    // Protect if subscriptions if enabled
    if (modelConfiguration.getName('level') !== 'off') {
      this.protectSubscription('onCreate', ctx, rules.subscription, def, modelConfiguration);
      this.protectSubscription('onUpdate', ctx, rules.subscription, def, modelConfiguration);
      this.protectSubscription('onDelete', ctx, rules.subscription, def, modelConfiguration);
    }
  };

  private protectSingleItemAction(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode | null,
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && resolver) {
      //  Adding role check to the current request template
      const roleCheck = genRoleCheckMappingTemplate(rule, parent.name.value);
      resolver.Properties.RequestMappingTemplate = roleCheck + resolver.Properties.RequestMappingTemplate;

      //  Set the flag that we need pipeline functions at the end
      this.needPipelineFunctions = true
      convertWithRoleChecking(ctx, parent, resolverResourceId, resolver, rule.instanceField);
    }
  }

  private protectListQuery(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Maybe<ListRule>,
    parent: ObjectTypeDefinitionNode | null,
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && rule.listConfig && resolver) {
      if (rule.listConfig.kind === 'LIST_BY_INSTANCE_ROLE_LOOKUP') {
        //  Set the flag that we need pipeline functions at the end
        this.needPipelineFunctions = true
        convertListToInstanceRoleLookup(ctx, resolverResourceId, resolver, rule, parent);
      } else if (rule.listConfig.kind === 'LIST_BY_ORGANISATION_ID') {
        //  Set the flag that we need pipeline functions at the end
        this.needPipelineFunctions = true
        convertListToOrganisationIDLookup(ctx, resolverResourceId, resolver, rule, parent)
      }
    }
  }

  /*
  private protectSearchQuery(ctx: TransformerContext, def: ObjectTypeDefinitionNode, resolverResourceId: string, rule: Rule) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rules || rules.length === 0 || !resolver) {
      return;
    } else {
      const operationName = resolver.Properties.FieldName;
      const includeDefault = def !== null ? this.isTypeHasRulesForOperation(def, 'list') : false;
      const operationDirectives = this.getDirectivesForRules(rules, includeDefault);
      if (operationDirectives.length > 0) {
        this.addDirectivesToOperation(ctx, ctx.getQueryTypeName(), operationName, operationDirectives);
      }
      this.addFieldToResourceReferences(ctx.getQueryTypeName(), operationName, rules);
      // create auth expression
      const authExpression = this.authorizationExpressionForListResult(rules, 'es_items');
      if (authExpression) {
        const templateParts = [
          print(this.resources.makeESItemsExpression(ctx.isProjectUsingDataStore())),
          print(authExpression),
          print(this.resources.makeESToGQLExpression()),
        ];
        resolver.Properties.ResponseMappingTemplate = templateParts.join('\n\n');
        ctx.setResource(resolverResourceId, resolver);
      }
    }
  }
  */

  private protectSyncQuery(
    ctx: TransformerContext,
    parent: ObjectTypeDefinitionNode,
    resolverResourceId: string,
    rule: Maybe<ListRule>,
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && rule.listConfig && resolver) {

    }
  }

  // Subscription
  private protectSubscription(
    subscriptionType: ModelDirectiveOperationType,
    ctx: TransformerContext,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const names = modelConfiguration.getNames(subscriptionType);
    const level = modelConfiguration.getName('level') as ModelSubscriptionLevel;
    if (names) {
      names.forEach(name => {
        this.addSubscriptionResolvers(subscriptionType, ctx, rule, parent, level, name);
      });
    }
  }

  private generateSubscriptionResolver(fieldName: string, subscriptionTypeName: string = 'Subscription') {
    return new AppSync.Resolver({
      ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
      DataSourceName: 'NONE',
      FieldName: fieldName,
      TypeName: subscriptionTypeName,
      RequestMappingTemplate: print(raw(`{
  "version": "${RESOLVER_VERSION_ID}",
  "payload": {}
}`),
      ),
      ResponseMappingTemplate: print(raw(`$util.toJson(null)`)),
    });
  }

  private noneDataSource() {
    return new AppSync.DataSource({
      ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
      Name: 'NONE',
      Type: 'NONE',
    });
  }

  // adds subscription resolvers (request / response) based on the operation provided
  private addSubscriptionResolvers(
    subscriptionType: ModelDirectiveOperationType,
    ctx: TransformerContext,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    level: ModelSubscriptionLevel,
    fieldName: string,
  ) {
    const resolverResourceId = ResolverResourceIDs.ResolverResourceID('Subscription', fieldName);
    const resolver = this.generateSubscriptionResolver(fieldName);
    // If the data source does not exist it is created and added as a resource for public && on levels
    const noneDS = ctx.getResource(ResourceConstants.RESOURCES.NoneDataSource);

    // add the rules in the subscription resolver
    if (rule) {
      // if (level === 'public') {
      //   // set the resource with no auth logic
      //   ctx.setResource(resolverResourceId, resolver);
      // } else {
      //   // TODO: Implement subscription authorization resolver (should be transformed into pipeline resolver)
      //   this.convertSingleActionToPipelineResolver(ctx, parent, resolverResourceId, resolver, rule.instanceField);
      // }
      // // If the subscription level is set to public it adds the subscription resolver with no auth logic
      // if (!noneDS) {
      //   ctx.setResource(ResourceConstants.RESOURCES.NoneDataSource, this.noneDataSource());
      // }
      // // finally map the resource to the stack
      // ctx.mapResourceToStack(parent.name.value, resolverResourceId);
    }
  }

  private getAuthRulesFromDirective(directive: DirectiveNode): AuthRule {
    const get = (s: string) => (arg: ArgumentNode) => arg.name.value === s;
    const getArg = (arg: string, dflt?: any) => {
      const argument = directive.arguments.find(get(arg));
      return argument ? valueFromASTUntyped(argument.value) : dflt;
    };

    // Get and validate the auth rules.
    const rules = getArg('rules', []) as AuthRuleDirective[];
    const mappedRules: AuthRule = {} as AuthRule;

    rules.forEach(rule => {
      rule.actions.forEach(action => {
        mappedRules[action.toLocaleLowerCase()] = { kind: rule.kind, allowedRoles: rule.allowedRoles, instanceField: rule.instanceField };
      });
    });

    const listConfig = getArg('listConfig') as ListConfig;
    if (mappedRules.list && listConfig) {
      mappedRules.list.listConfig = listConfig;
    }

    return mappedRules;
  }

  private isSyncEnabled(ctx: TransformerContext, typeName: string): boolean {
    const resolverConfig = ctx.getResolverConfig();
    if (resolverConfig && resolverConfig.project) {
      return true;
    }
    if (resolverConfig && resolverConfig.models && resolverConfig.models[typeName]) {
      return true;
    }
    return false;
  }
}

export default ModelCustomAuthTransformer;
