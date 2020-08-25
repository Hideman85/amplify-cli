import {gql, InvalidDirectiveError, Transformer, TransformerContext} from 'graphql-transformer-core'
import {AuthRule, AuthRuleDirective, Rule} from './AuthRule'
import {ArgumentNode, DirectiveNode, ObjectTypeDefinitionNode, valueFromASTUntyped} from 'graphql'
import {ResolverResourceIDs, ResourceConstants} from 'graphql-transformer-common'
import {compoundExpression, Expression, list, print, raw, RESOLVER_VERSION_ID} from 'graphql-mapping-template'
import {ModelDirectiveConfiguration, ModelSubscriptionLevel} from './ModelDirectiveConfiguration'
import {AppSync, Fn} from 'cloudform-types'

export class ModelCustomAuthTransformer extends Transformer {
  constructor() {
    super(
      'ModelCustomAuthTransformer',
      gql`
        directive @CustomAuth(rules: [Rule!]!) on OBJECT
        enum RoleKindEnum {
          ORGANISATION_ROLE
          INSTANCE_ROLE
        }
        enum OrganisationRoleEnum {
          VIEWING_ACCESS
          CREATING_ACCESS
          ADMIN_ ACCESS
        }
        enum InstanceRoleEnum {
          VIEWING_ACCESS
          COMMENTING_ACCESS
          EDITING_ACCESS
        }
        union Role = OrganisationRoleEnum | InstanceRoleEnum
        enum ActionEnum {
          GET
          LIST
          CREATE
          UPDATE
          DELETE
          SUBSCRIPTION
        }
        input Rule {
          action: ActionEnum!
          kind: RoleKindEnum!
          allowedRoles: [Role!]!
        }
      `,
    );
  }

  /**
   * Implement the transform for an object type. Depending on which operations are to be protected
   */
  public object = (def: ObjectTypeDefinitionNode, directive: DirectiveNode, ctx: TransformerContext): void => {
    const modelDirective = def.directives.find(dir => dir.name.value === 'model');
    if (!modelDirective) {
      throw new InvalidDirectiveError('Types annotated with @auth must also be annotated with @model.');
    }

    // check if searchable is enabled on the type
    const searchableDirective = def.directives.find(dir => dir.name.value === 'searchable');

    // Get and validate the auth rules.
    const rules = this.getAuthRulesFromDirective(directive);

    // Retrieve the configuration options for the related @model directive
    const modelConfiguration = new ModelDirectiveConfiguration(modelDirective, def);

    // For each operation evaluate the rules and apply the changes to the relevant resolver.
    this.protectCreateMutation(
      ctx,
      ResolverResourceIDs.DynamoDBCreateResolverResourceID(def.name.value),
      rules.create,
      def,
      modelConfiguration,
    );
    this.protectUpdateMutation(
      ctx,
      ResolverResourceIDs.DynamoDBUpdateResolverResourceID(def.name.value),
      rules.update,
      def,
      modelConfiguration,
    );
    this.protectDeleteMutation(
      ctx,
      ResolverResourceIDs.DynamoDBDeleteResolverResourceID(def.name.value),
      rules.delete,
      def,
      modelConfiguration,
    );
    this.protectGetQuery(
      ctx,
      ResolverResourceIDs.DynamoDBGetResolverResourceID(def.name.value),
      rules.get,
      def,
      modelConfiguration
    );
    this.protectListQuery(
      ctx,
      ResolverResourceIDs.DynamoDBListResolverResourceID(def.name.value),
      rules.list,
      def,
      modelConfiguration,
    );

    // protect search query if @searchable is enabled
    if (searchableDirective) {
      throw new Error('@searchable with @CustomAuth Not implemented yet!')
      // this.protectSearchQuery(ctx, def, ResolverResourceIDs.ElasticsearchSearchResolverResourceID(def.name.value), rules.list);
    }

    // protect sync query if model is sync enabled
    if (this.isSyncEnabled(ctx, def.name.value)) {
      this.protectSyncQuery(ctx, def, ResolverResourceIDs.SyncResolverResourceID(def.name.value), rules.list);
    }

    // Check if subscriptions is enabled
    if (modelConfiguration.getName('level') !== 'off') {
      this.protectOnCreateSubscription(ctx, rules.subscription, def, modelConfiguration);
      this.protectOnUpdateSubscription(ctx, rules.subscription, def, modelConfiguration);
      this.protectOnDeleteSubscription(ctx, rules.subscription, def, modelConfiguration);
    }

  };

  /**
   * Protect get queries.
   * If static group:
   *  If statically authorized then allow the operation. Stop.
   * If owner and/or dynamic group:
   *  If the result item satisfies the owner/group authorization condition
   *  then allow it.
   * @param ctx The transformer context.
   * @param resolverResourceId The logical id of the get resolver.
   * @param rules The auth rules to apply.
   */
  private protectGetQuery(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode | null,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rule || !resolver) {
      return;
    } else {
      let operationName: string = undefined;

      const authExpression = this.authorizationExpressionOnSingleObject(rule);

      if (authExpression) {
        const templateParts = [print(authExpression), resolver.Properties.ResponseMappingTemplate];
        resolver.Properties.ResponseMappingTemplate = templateParts.join('\n\n');
        ctx.setResource(resolverResourceId, resolver);
      }
    }
  }

  private authorizationExpressionOnSingleObject(rule: Rule, objectPath: string = 'ctx.result'): Expression {
    //  TODO: Implement resolver mapping template
    return null
  }

  /**
   * Protect list queries.
   * If static group:
   *  If the user is statically authorized then return items and stop.
   * If dynamic group and/or owner:
   *  Loop through all items and find items that satisfy any of the group or
   *  owner conditions.
   * @param ctx The transformer context.
   * @param resolverResourceId The logical id of the resolver to be updated in the CF template.
   * @param rules The set of rules that apply to the operation.
   */
  private protectListQuery(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode | null,
    modelConfiguration: ModelDirectiveConfiguration,
    explicitOperationName: string = undefined,
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rule || !resolver) {
      return;
    }
    const operationName = explicitOperationName ? explicitOperationName : modelConfiguration.getName('list');
    const authExpression = this.authorizationExpressionForListResult(rule);

    if (authExpression) {
      const templateParts = [print(authExpression), resolver.Properties.ResponseMappingTemplate];
      resolver.Properties.ResponseMappingTemplate = templateParts.join('\n\n');
      ctx.setResource(resolverResourceId, resolver);
    }
  }

  /**
   * Returns a VTL expression that will authorize a list of results based on a set of auth rules.
   * @param rules The auth rules.
   *
   * If an itemList is specifed in @param itemList it will use this ref to filter out items in this list that are not authorized
   */
  private authorizationExpressionForListResult(rule: Rule, itemList: string = 'ctx.result.items'): Expression {
    //  TODO: Implement resolver mapping template
    return null
  }

  /**
   * Inject auth rules for create mutations.
   * If owner auth:
   *  If the owner field exists in the input, validate that it against the identity.
   *  If the owner field dne in the input, insert the identity.
   * If group:
   *  If the user is static group authorized allow operation no matter what.
   *  If dynamic group and the input defines a group(s) validate it against the identity.
   * @param ctx
   * @param resolverResourceId
   * @param rule
   */
  private protectCreateMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rule || !resolver) {
      return;
    } else {
      const mutationTypeName = ctx.getMutationTypeName();

      // TODO: Implement
      const expressions = []
      const templateParts = [print(compoundExpression(expressions)), resolver.Properties.RequestMappingTemplate];
      resolver.Properties.RequestMappingTemplate = templateParts.join('\n\n');
      ctx.setResource(resolverResourceId, resolver);
    }
  }

  /**
   * Protect update and delete mutations.
   * If Owner:
   *  Update the conditional expression such that the update only works if
   *  the user is the owner.
   * If dynamic group:
   *  Update the conditional expression such that it succeeds if the user is
   *  dynamic group authorized. If the operation is also owner authorized this
   *  should be joined with an OR expression.
   * If static group:
   *  If the user is statically authorized then allow no matter what. This can
   *  be done by removing the conditional expression as long as static group
   *  auth is always checked last.
   * @param ctx The transformer context.
   * @param resolverResourceId The logical id of the resolver in the template.
   * @param rule The list of rules to apply.
   */
  private protectUpdateOrDeleteMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
    isUpdate: boolean
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rule || !resolver) {
      return;
    } else {
      const mutationTypeName = ctx.getMutationTypeName();
      const operationName = modelConfiguration.getName(isUpdate ? 'update' : 'delete');

      // TODO: Implement
      const expressions = []
      const templateParts = [print(compoundExpression(expressions)), resolver.Properties.RequestMappingTemplate];
      resolver.Properties.RequestMappingTemplate = templateParts.join('\n\n');
      ctx.setResource(resolverResourceId, resolver);
    }
  }

  /**
   * If we are protecting the mutation for a field level @auth directive, include
   * the necessary if condition.
   * @param ctx The transformer context
   * @param resolverResourceId The resolver resource id
   * @param rule The delete rules
   * @param parent The parent object
   * @param field The optional field
   */
  private protectUpdateMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration
  ) {
    return this.protectUpdateOrDeleteMutation(
      ctx,
      resolverResourceId,
      rule,
      parent,
      modelConfiguration,
      true
    );
  }

  /**
   * If we are protecting the mutation for a field level @auth directive, include
   * the necessary if condition.
   * @param ctx The transformer context
   * @param resolverResourceId The resolver resource id
   * @param rule The delete rules
   * @param parent The parent object
   */
  private protectDeleteMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration
  ) {
    return this.protectUpdateOrDeleteMutation(
      ctx,
      resolverResourceId,
      rule,
      parent,
      modelConfiguration,
      false
    );
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

  private protectSyncQuery(ctx: TransformerContext, def: ObjectTypeDefinitionNode, resolverResourceID: string, rule: Rule) {
    const resolver = ctx.getResource(resolverResourceID);
    if (!rule || !resolver) {
      return;
    }
    const operationName = resolver.Properties.FieldName;
    // create auth expression
    const authExpression = this.authorizationExpressionForListResult(rule);
    if (authExpression) {
      const templateParts = [print(authExpression), resolver.Properties.ResponseMappingTemplate];
      resolver.Properties.ResponseMappingTemplate = templateParts.join('\n\n');
      ctx.setResource(resolverResourceID, resolver);
    }
  }

  // OnCreate Subscription
  private protectOnCreateSubscription(
    ctx: TransformerContext,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const names = modelConfiguration.getNames('onCreate');
    const level = modelConfiguration.getName('level') as ModelSubscriptionLevel;
    if (names) {
      names.forEach(name => {
        this.addSubscriptionResolvers(ctx, rule, parent, level, name);
      });
    }
  }

  // OnUpdate Subscription
  private protectOnUpdateSubscription(
    ctx: TransformerContext,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const names = modelConfiguration.getNames('onUpdate');
    const level = modelConfiguration.getName('level') as ModelSubscriptionLevel;
    if (names) {
      names.forEach(name => {
        this.addSubscriptionResolvers(ctx, rule, parent, level, name);
      });
    }
  }

  // OnDelete Subscription
  private protectOnDeleteSubscription(
    ctx: TransformerContext,
    rule: Rule,
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const names = modelConfiguration.getNames('onDelete');
    const level = modelConfiguration.getName('level') as ModelSubscriptionLevel;
    if (names) {
      names.forEach(name => {
        this.addSubscriptionResolvers(ctx, rule, parent, level, name);
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
    if (!rule) {
      return;
    } else if (level === 'public') {
      // set the resource with no auth logic
      ctx.setResource(resolverResourceId, resolver);
    } else {
      // TODO: Implement subscription authorization resolver (should be transformed into pipeline resolver)
    }
    // If the subscription level is set to public it adds the subscription resolver with no auth logic
    if (!noneDS) {
      ctx.setResource(ResourceConstants.RESOURCES.NoneDataSource, this.noneDataSource());
    }
    // finally map the resource to the stack
    ctx.mapResourceToStack(parent.name.value, resolverResourceId);
  }

  /**
   * Parse rules from the GraphQL directive @CustomAuth
   * @param directive
   * @private
   */
  private getAuthRulesFromDirective(directive: DirectiveNode): AuthRule {
    const get = (s: string) => (arg: ArgumentNode) => arg.name.value === s;
    const getArg = (arg: string, dflt?: any) => {
      const argument = directive.arguments.find(get(arg));
      return argument ? valueFromASTUntyped(argument.value) : dflt;
    };

    // Get and validate the auth rules.
    const rules = getArg('rules', []) as AuthRuleDirective[];
    const mappedRules : AuthRule = {} as AuthRule;
    rules.forEach(rule => {
      mappedRules[rule.action.toLocaleLowerCase()] = { kind: rule.kind, allowedRoles: rule.allowedRoles };
    });
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
