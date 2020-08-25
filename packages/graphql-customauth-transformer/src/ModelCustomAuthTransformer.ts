import {
  getDirectiveArguments,
  gql,
  InvalidDirectiveError,
  Transformer,
  TransformerContext
} from 'graphql-transformer-core'
import Resolver from 'cloudform-types/types/appSync/resolver'
import {ResourceFactory} from './resources'
import {AuthProvider, AuthRule} from './AuthRule'
import {ArgumentNode, DirectiveNode, FieldDefinitionNode, Kind, NamedTypeNode, ObjectTypeDefinitionNode, valueFromASTUntyped} from 'graphql'
import {
  blankObjectExtension,
  extendFieldWithDirectives,
  extensionWithDirectives,
  isListType,
  makeDirective,
  ResolverResourceIDs,
  ResourceConstants
} from 'graphql-transformer-common'
import {comment, compoundExpression, Expression, forEach, iff, list, newline, not, print, raw, ref, set} from 'graphql-mapping-template'
import {ModelDirectiveConfiguration, ModelDirectiveOperationType, ModelSubscriptionLevel} from './ModelDirectiveConfiguration'

export class ModelCustomAuthTransformer extends Transformer {
  resources: ResourceFactory;

  constructor() {
    super(
      'ModelCustomAuthTransformer',
      gql`
        directive @customauth(rules: [Rule!]!) on OBJECT
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
          roles: [Role!]!
        }
      `,
    );
    this.resources = new ResourceFactory();
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
    // Assign default providers to rules where no provider was explicitly defined
    this.ensureDefaultAuthProviderAssigned(rules);
    this.validateRules(rules);
    // Check the rules if we've to generate IAM policies for Unauth role or not
    this.setAuthPolicyFlag(rules);
    this.setUnauthPolicyFlag(rules);

    // Check if the object type has fields of type without the @model directive.
    // We've to make sure that appropriate @aws_* directive will be added and a policy entry for the
    // type will be emitted as well in case of IAM.
    this.propagateAuthDirectivesToNestedTypes(def, rules, ctx);

    const { operationRules, queryRules } = this.splitRules(rules);

    // Retrieve the configuration options for the related @model directive
    const modelConfiguration = new ModelDirectiveConfiguration(modelDirective, def);
    // Get the directives we need to add to the GraphQL nodes
    const directives = this.getDirectivesForRules(rules, false);

    // Add the directives to the Type node itself
    if (directives.length > 0) {
      this.extendTypeWithDirectives(ctx, def.name.value, directives);
    }

    this.addTypeToResourceReferences(def.name.value, rules);

    // For each operation evaluate the rules and apply the changes to the relevant resolver.
    this.protectCreateMutation(
      ctx,
      ResolverResourceIDs.DynamoDBCreateResolverResourceID(def.name.value),
      operationRules.create,
      def,
      modelConfiguration,
    );
    this.protectUpdateMutation(
      ctx,
      ResolverResourceIDs.DynamoDBUpdateResolverResourceID(def.name.value),
      operationRules.update,
      def,
      modelConfiguration,
    );
    this.protectDeleteMutation(
      ctx,
      ResolverResourceIDs.DynamoDBDeleteResolverResourceID(def.name.value),
      operationRules.delete,
      def,
      modelConfiguration,
    );
    this.protectGetQuery(ctx, ResolverResourceIDs.DynamoDBGetResolverResourceID(def.name.value), queryRules.get, def, modelConfiguration);
    this.protectListQuery(
      ctx,
      ResolverResourceIDs.DynamoDBListResolverResourceID(def.name.value),
      queryRules.list,
      def,
      modelConfiguration,
    );
    this.protectQueries(ctx, def, operationRules.read, modelConfiguration);

    // protect search query if @searchable is enabled
    if (searchableDirective) {
      this.protectSearchQuery(ctx, def, ResolverResourceIDs.ElasticsearchSearchResolverResourceID(def.name.value), operationRules.read);
    }

    // protect sync query if model is sync enabled
    if (this.isSyncEnabled(ctx, def.name.value)) {
      this.protectSyncQuery(ctx, def, ResolverResourceIDs.SyncResolverResourceID(def.name.value), operationRules.read);
    }

    // Check if subscriptions is enabled
    if (modelConfiguration.getName('level') !== 'off') {
      this.protectOnCreateSubscription(ctx, operationRules.read, def, modelConfiguration);
      this.protectOnUpdateSubscription(ctx, operationRules.read, def, modelConfiguration);
      this.protectOnDeleteSubscription(ctx, operationRules.read, def, modelConfiguration);
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
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode | null,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rules || rules.length === 0 || !resolver) {
      return;
    } else {
      let operationName: string = undefined;

      if (modelConfiguration.shouldHave('get')) {
        operationName = modelConfiguration.getName('get');
        // If the parent type has any rules for this operation AND
        // the default provider we've to get directives including the default
        // as well.
        const includeDefault = parent !== null ? this.isTypeHasRulesForOperation(parent, 'get') : false;
        const operationDirectives = this.getDirectivesForRules(rules, includeDefault);

        if (operationDirectives.length > 0) {
          this.addDirectivesToOperation(ctx, ctx.getQueryTypeName(), operationName, operationDirectives);
        }
      }

      if (operationName) {
        this.addFieldToResourceReferences(ctx.getQueryTypeName(), operationName, rules);
      }

      const authExpression = this.authorizationExpressionOnSingleObject(rules);

      if (authExpression) {
        const templateParts = [print(authExpression), resolver.Properties.ResponseMappingTemplate];
        resolver.Properties.ResponseMappingTemplate = templateParts.join('\n\n');
        ctx.setResource(resolverResourceId, resolver);
      }
    }
  }

  private authorizationExpressionOnSingleObject(rules: AuthRule[], objectPath: string = 'ctx.result') {
    //  TODO: Implement resolver mapping template
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
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode | null,
    modelConfiguration: ModelDirectiveConfiguration,
    explicitOperationName: string = undefined,
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rules || rules.length === 0 || !resolver) {
      return;
    }

    if (modelConfiguration.shouldHave('list')) {
      const operationName = explicitOperationName ? explicitOperationName : modelConfiguration.getName('list');
      // If the parent type has any rules for this operation AND
      // the default provider we've to get directives including the default
      // as well.
      const includeDefault = parent !== null ? this.isTypeHasRulesForOperation(parent, 'list') : false;
      const operationDirectives = this.getDirectivesForRules(rules, includeDefault);

      if (operationDirectives.length > 0) {
        this.addDirectivesToOperation(ctx, ctx.getQueryTypeName(), operationName, operationDirectives);
      }

      this.addFieldToResourceReferences(ctx.getQueryTypeName(), operationName, rules);
    }

    const authExpression = this.authorizationExpressionForListResult(rules);

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
  private authorizationExpressionForListResult(rules: AuthRule[], itemList: string = 'ctx.result.items') {
    //  TODO: Implement resolver mapping template
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
   * @param rules
   */
  private protectCreateMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rules || rules.length === 0 || !resolver) {
      return;
    } else {
      const mutationTypeName = ctx.getMutationTypeName();

      if (modelConfiguration.shouldHave('create')) {
        const operationName = modelConfiguration.getName('create');
        // If the parent type has any rules for this operation AND
        // the default provider we've to get directives including the default
        // as well.
        const includeDefault = this.isTypeHasRulesForOperation(parent, 'create');
        const operationDirectives = this.getDirectivesForRules(rules, includeDefault);

        if (operationDirectives.length > 0) {
          this.addDirectivesToOperation(ctx, mutationTypeName, operationName, operationDirectives);
        }

        this.addFieldToResourceReferences(mutationTypeName, operationName, rules);
      }

      // Break the rules out by strategy.
      const staticGroupAuthorizationRules = this.getStaticGroupRules(rules);
      const dynamicGroupAuthorizationRules = this.getDynamicGroupRules(rules);
      const ownerAuthorizationRules = this.getOwnerRules(rules);
      const providerAuthorization = this.hasProviderAuthRules(rules);

      if (
        (staticGroupAuthorizationRules.length > 0 || dynamicGroupAuthorizationRules.length > 0 || ownerAuthorizationRules.length > 0) &&
        providerAuthorization === false
      ) {
        // Generate the expressions to validate each strategy.
        const staticGroupAuthorizationExpression = this.resources.staticGroupAuthorizationExpression(staticGroupAuthorizationRules);

        // In create mutations, the dynamic group and ownership authorization checks
        // are done before calling PutItem.
        const dynamicGroupAuthorizationExpression = this.resources.dynamicGroupAuthorizationExpressionForCreateOperations(
          dynamicGroupAuthorizationRules,
        );
        const fieldIsList = (fieldName: string) => {
          const field = parent.fields.find(field => field.name.value === fieldName);
          if (field) {
            return isListType(field.type);
          }
          return false;
        };
        const ownerAuthorizationExpression = this.resources.ownerAuthorizationExpressionForCreateOperations(
          ownerAuthorizationRules,
          fieldIsList,
        );

        const throwIfUnauthorizedExpression = this.resources.throwIfUnauthorized();

        // If we've any modes to check, then add the authMode check code block
        // to the start of the resolver.
        const authModesToCheck = new Set<AuthProvider>();
        const expressions: Array<Expression> = new Array();

        if (
          ownerAuthorizationRules.find(r => r.provider === 'userPools') ||
          staticGroupAuthorizationRules.find(r => r.provider === 'userPools') ||
          dynamicGroupAuthorizationRules.find(r => r.provider === 'userPools')
        ) {
          authModesToCheck.add('userPools');
        }
        if (
          ownerAuthorizationRules.find(r => r.provider === 'oidc') ||
          staticGroupAuthorizationRules.find(r => r.provider === 'oidc') ||
          dynamicGroupAuthorizationRules.find(r => r.provider === 'oidc')
        ) {
          authModesToCheck.add('oidc');
        }

        if (authModesToCheck.size > 0) {
          const isUserPoolTheDefault = this.configuredAuthProviders.default === 'userPools';
          expressions.push(this.resources.getAuthModeDeterminationExpression(authModesToCheck, isUserPoolTheDefault));
        }

        // These statements will be wrapped into an authMode check if statement
        const authCheckExpressions = [
          staticGroupAuthorizationExpression,
          newline(),
          dynamicGroupAuthorizationExpression,
          newline(),
          ownerAuthorizationExpression,
          newline(),
          throwIfUnauthorizedExpression,
        ];

        // Create the authMode if block and add it to the resolver
        expressions.push(this.resources.getAuthModeCheckWrappedExpression(authModesToCheck, compoundExpression(authCheckExpressions)));

        const templateParts = [print(compoundExpression(expressions)), resolver.Properties.RequestMappingTemplate];
        resolver.Properties.RequestMappingTemplate = templateParts.join('\n\n');
        ctx.setResource(resolverResourceId, resolver);
      }
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
   * @param rules The list of rules to apply.
   */
  private protectUpdateOrDeleteMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
    isUpdate: boolean,
    field?: FieldDefinitionNode,
    ifCondition?: Expression,
    subscriptionOperation?: ModelDirectiveOperationType,
  ) {
    const resolver = ctx.getResource(resolverResourceId);
    if (!rules || rules.length === 0 || !resolver) {
      return;
    } else {
      const mutationTypeName = ctx.getMutationTypeName();

      if (modelConfiguration.shouldHave(isUpdate ? 'update' : 'delete')) {
        const operationName = modelConfiguration.getName(isUpdate ? 'update' : 'delete');
        // If the parent type has any rules for this operation AND
        // the default provider we've to get directives including the default
        // as well.
        const includeDefault = Boolean(!field && this.isTypeHasRulesForOperation(parent, isUpdate ? 'update' : 'delete'));
        const operationDirectives = this.getDirectivesForRules(rules, includeDefault);

        if (operationDirectives.length > 0) {
          this.addDirectivesToOperation(ctx, mutationTypeName, operationName, operationDirectives);
        }

        this.addFieldToResourceReferences(mutationTypeName, operationName, rules);
      }

      // Break the rules out by strategy.
      const staticGroupAuthorizationRules = this.getStaticGroupRules(rules);
      const dynamicGroupAuthorizationRules = this.getDynamicGroupRules(rules);
      const ownerAuthorizationRules = this.getOwnerRules(rules);
      const providerAuthorization = this.hasProviderAuthRules(rules);

      if (
        (staticGroupAuthorizationRules.length > 0 || dynamicGroupAuthorizationRules.length > 0 || ownerAuthorizationRules.length > 0) &&
        providerAuthorization === false
      ) {
        // Generate the expressions to validate each strategy.
        const staticGroupAuthorizationExpression = this.resources.staticGroupAuthorizationExpression(staticGroupAuthorizationRules, field);

        const fieldIsList = (fieldName: string) => {
          const field = parent.fields.find(field => field.name.value === fieldName);
          if (field) {
            return isListType(field.type);
          }
          return false;
        };

        // In create mutations, the dynamic group and ownership authorization checks
        // are done before calling PutItem.
        const dynamicGroupAuthorizationExpression = this.resources.dynamicGroupAuthorizationExpressionForUpdateOrDeleteOperations(
          dynamicGroupAuthorizationRules,
          fieldIsList,
          field ? field.name.value : undefined,
        );

        const ownerAuthorizationExpression = this.resources.ownerAuthorizationExpressionForUpdateOrDeleteOperations(
          ownerAuthorizationRules,
          fieldIsList,
          field ? field.name.value : undefined,
        );

        const collectAuthCondition = this.resources.collectAuthCondition();
        const staticGroupAuthorizedVariable = this.resources.getStaticAuthorizationVariable(field);
        const ifNotStaticallyAuthedCreateAuthCondition = iff(
          raw(`! $${staticGroupAuthorizedVariable}`),
          compoundExpression([
            dynamicGroupAuthorizationExpression,
            newline(),
            ownerAuthorizationExpression,
            newline(),
            collectAuthCondition,
          ]),
        );

        const throwIfNotStaticGroupAuthorizedOrAuthConditionIsEmpty = this.resources.throwIfNotStaticGroupAuthorizedOrAuthConditionIsEmpty(
          field,
        );

        // If we've any modes to check, then add the authMode check code block
        // to the start of the resolver.
        const authModesToCheck = new Set<AuthProvider>();
        const expressions: Array<Expression> = new Array();

        if (
          ownerAuthorizationRules.find(r => r.provider === 'userPools') ||
          staticGroupAuthorizationRules.find(r => r.provider === 'userPools') ||
          dynamicGroupAuthorizationRules.find(r => r.provider === 'userPools')
        ) {
          authModesToCheck.add('userPools');
        }
        if (
          ownerAuthorizationRules.find(r => r.provider === 'oidc') ||
          staticGroupAuthorizationRules.find(r => r.provider === 'oidc') ||
          dynamicGroupAuthorizationRules.find(r => r.provider === 'oidc')
        ) {
          authModesToCheck.add('oidc');
        }

        if (authModesToCheck.size > 0) {
          const isUserPoolTheDefault = this.configuredAuthProviders.default === 'userPools';
          expressions.push(this.resources.getAuthModeDeterminationExpression(authModesToCheck, isUserPoolTheDefault));
        }

        // These statements will be wrapped into an authMode check if statement
        const authorizationLogic = compoundExpression([
          staticGroupAuthorizationExpression,
          newline(),
          ifNotStaticallyAuthedCreateAuthCondition,
          newline(),
          throwIfNotStaticGroupAuthorizedOrAuthConditionIsEmpty,
        ]);

        // Create the authMode if block and add it to the resolver
        expressions.push(this.resources.getAuthModeCheckWrappedExpression(authModesToCheck, authorizationLogic));

        const templateParts = [
          print(field && ifCondition ? iff(ifCondition, compoundExpression(expressions)) : compoundExpression(expressions)),
          resolver.Properties.RequestMappingTemplate,
        ];
        resolver.Properties.RequestMappingTemplate = templateParts.join('\n\n');
        ctx.setResource(resolverResourceId, resolver);
      }

      // if protect is for field and there is a subscription for update / delete then protect the field in that operation
      if (
        field &&
        subscriptionOperation &&
        modelConfiguration.shouldHave(subscriptionOperation) &&
        (modelConfiguration.getName('level') as ModelSubscriptionLevel) === 'on'
      ) {
        let mutationResolver = resolver;
        let mutationResolverResourceID = resolverResourceId;
        // if we are protecting delete then we need to get the delete resolver
        if (subscriptionOperation === 'onDelete') {
          mutationResolverResourceID = ResolverResourceIDs.DynamoDBDeleteResolverResourceID(parent.name.value);
          mutationResolver = ctx.getResource(mutationResolverResourceID);
        }
        const getTemplateParts = [mutationResolver.Properties.ResponseMappingTemplate];
        if (!this.isOperationExpressionSet(mutationTypeName, mutationResolver.Properties.ResponseMappingTemplate)) {
          getTemplateParts.unshift(this.resources.setOperationExpression(mutationTypeName));
        }
        mutationResolver.Properties.ResponseMappingTemplate = getTemplateParts.join('\n\n');
        ctx.setResource(mutationResolverResourceID, mutationResolver);
      }
    }
  }

  /**
   * If we are protecting the mutation for a field level @auth directive, include
   * the necessary if condition.
   * @param ctx The transformer context
   * @param resolverResourceId The resolver resource id
   * @param rules The delete rules
   * @param parent The parent object
   * @param field The optional field
   */
  private protectUpdateMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
    field?: FieldDefinitionNode,
    subscriptionOperation?: ModelDirectiveOperationType,
  ) {
    return this.protectUpdateOrDeleteMutation(
      ctx,
      resolverResourceId,
      rules,
      parent,
      modelConfiguration,
      true,
      field,
      field ? raw(`$ctx.args.input.containsKey("${field.name.value}")`) : undefined,
      subscriptionOperation,
    );
  }

  /**
   * If we are protecting the mutation for a field level @auth directive, include
   * the necessary if condition.
   * @param ctx The transformer context
   * @param resolverResourceId The resolver resource id
   * @param rules The delete rules
   * @param parent The parent object
   * @param field The optional field
   */
  private protectDeleteMutation(
    ctx: TransformerContext,
    resolverResourceId: string,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
    field?: FieldDefinitionNode,
    subscriptionOperation?: ModelDirectiveOperationType,
  ) {
    return this.protectUpdateOrDeleteMutation(
      ctx,
      resolverResourceId,
      rules,
      parent,
      modelConfiguration,
      false,
      field,
      field
        ? raw(`$ctx.args.input.containsKey("${field.name.value}") && $util.isNull($ctx.args.input.get("${field.name.value}"))`)
        : undefined,
      subscriptionOperation,
    );
  }

  /**
   * When read operations are protected via @auth, all secondary @key query resolvers will be protected.
   * Find the directives & update their resolvers with auth logic
   */
  private protectQueries(
    ctx: TransformerContext,
    def: ObjectTypeDefinitionNode,
    rules: AuthRule[],
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const secondaryKeyDirectivesWithQueries = (def.directives || []).filter(d => {
      const isKey = d.name.value === 'key';
      const args = getDirectiveArguments(d);
      // @key with a name is a secondary key.
      const isSecondaryKey = Boolean(args.name);
      const hasQueryField = Boolean(args.queryField);
      return isKey && isSecondaryKey && hasQueryField;
    });
    for (const keyWithQuery of secondaryKeyDirectivesWithQueries) {
      const args = getDirectiveArguments(keyWithQuery);
      const resolverResourceId = ResolverResourceIDs.ResolverResourceID(ctx.getQueryTypeName(), args.queryField);
      this.protectListQuery(ctx, resolverResourceId, rules, null, modelConfiguration, args.queryField);
    }
  }

  private protectSearchQuery(ctx: TransformerContext, def: ObjectTypeDefinitionNode, resolverResourceId: string, rules: AuthRule[]) {
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

  private protectSyncQuery(ctx: TransformerContext, def: ObjectTypeDefinitionNode, resolverResourceID: string, rules: AuthRule[]) {
    const resolver = ctx.getResource(resolverResourceID);
    if (!rules || rules.length === 0 || !resolver) {
      return;
    }
    const operationName = resolver.Properties.FieldName;
    const includeDefault = def !== null ? this.isTypeHasRulesForOperation(def, 'list') : false;
    const operationDirectives = this.getDirectivesForRules(rules, includeDefault);
    if (operationDirectives.length > 0) {
      this.addDirectivesToOperation(ctx, ctx.getQueryTypeName(), operationName, operationDirectives);
    }
    this.addFieldToResourceReferences(ctx.getQueryTypeName(), operationName, rules);
    // create auth expression
    const authExpression = this.authorizationExpressionForListResult(rules);
    if (authExpression) {
      const templateParts = [print(authExpression), resolver.Properties.ResponseMappingTemplate];
      resolver.Properties.ResponseMappingTemplate = templateParts.join('\n\n');
      ctx.setResource(resolverResourceID, resolver);
    }
  }

  // OnCreate Subscription
  private protectOnCreateSubscription(
    ctx: TransformerContext,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const names = modelConfiguration.getNames('onCreate');
    const level = modelConfiguration.getName('level') as ModelSubscriptionLevel;
    if (names) {
      names.forEach(name => {
        this.addSubscriptionResolvers(ctx, rules, parent, level, name);
      });
    }
  }

  // OnUpdate Subscription
  private protectOnUpdateSubscription(
    ctx: TransformerContext,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const names = modelConfiguration.getNames('onUpdate');
    const level = modelConfiguration.getName('level') as ModelSubscriptionLevel;
    if (names) {
      names.forEach(name => {
        this.addSubscriptionResolvers(ctx, rules, parent, level, name);
      });
    }
  }

  // OnDelete Subscription
  private protectOnDeleteSubscription(
    ctx: TransformerContext,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const names = modelConfiguration.getNames('onDelete');
    const level = modelConfiguration.getName('level') as ModelSubscriptionLevel;
    if (names) {
      names.forEach(name => {
        this.addSubscriptionResolvers(ctx, rules, parent, level, name);
      });
    }
  }

  // adds subscription resolvers (request / response) based on the operation provided
  private addSubscriptionResolvers(
    ctx: TransformerContext,
    rules: AuthRule[],
    parent: ObjectTypeDefinitionNode,
    level: ModelSubscriptionLevel,
    fieldName: string,
  ) {
    const resolverResourceId = ResolverResourceIDs.ResolverResourceID('Subscription', fieldName);
    const resolver = this.resources.generateSubscriptionResolver(fieldName);
    // If the data source does not exist it is created and added as a resource for public && on levels
    const noneDS = ctx.getResource(ResourceConstants.RESOURCES.NoneDataSource);

    // add the rules in the subscription resolver
    if (!rules || rules.length === 0) {
      return;
    } else if (level === 'public') {
      // set the resource with no auth logic
      ctx.setResource(resolverResourceId, resolver);
    } else {
      // Get the directives we need to add to the GraphQL nodes
      const includeDefault = parent !== null ? this.isTypeHasRulesForOperation(parent, 'get') : false;
      const directives = this.getDirectivesForRules(rules, includeDefault);

      if (directives.length > 0) {
        this.addDirectivesToField(ctx, ctx.getSubscriptionTypeName(), fieldName, directives);
      }

      this.addFieldToResourceReferences(ctx.getSubscriptionTypeName(), fieldName, rules);

      //  Get the throwing rule for subscription
      const throwIfUnauthorizedExpression = this.resources.throwIfSubscriptionUnauthorized();

      // TODO: Implement subscription authorization resolver (should be transformed into pipeline resolver)
    }
    // If the subscription level is set to public it adds the subscription resolver with no auth logic
    if (!noneDS) {
      ctx.setResource(ResourceConstants.RESOURCES.NoneDataSource, this.resources.noneDataSource());
    }
    // finally map the resource to the stack
    ctx.mapResourceToStack(parent.name.value, resolverResourceId);
  }

  private getOwnerRules(rules: AuthRule[]): AuthRule[] {
    return rules.filter(rule => rule.allow === 'owner');
  }

  private getStaticGroupRules(rules: AuthRule[]): AuthRule[] {
    return rules.filter(rule => rule.allow === 'groups' && Boolean(rule.groups));
  }

  private getDynamicGroupRules(rules: AuthRule[]): AuthRule[] {
    return rules.filter(rule => rule.allow === 'groups' && !Boolean(rule.groups));
  }

  public hasProviderAuthRules(rules: AuthRule[]): Boolean {
    return rules.filter(rule => rule.provider === 'userPools' && (rule.allow === 'public' || rule.allow === 'private')).length > 0;
  }

  private extendTypeWithDirectives(ctx: TransformerContext, typeName: string, directives: DirectiveNode[]) {
    let objectTypeExtension = blankObjectExtension(typeName);

    objectTypeExtension = extensionWithDirectives(objectTypeExtension, directives);

    ctx.addObjectExtension(objectTypeExtension);
  }

  private addDirectivesToOperation(ctx: TransformerContext, typeName: string, operationName: string, directives: DirectiveNode[]) {
    // Add the directives to the given operation
    this.addDirectivesToField(ctx, typeName, operationName, directives);

    // Add the directives to the result type of the operation;
    const type = ctx.getType(typeName) as ObjectTypeDefinitionNode;

    if (type) {
      const field = type.fields.find(f => f.name.value === operationName);

      if (field) {
        const returnFieldType = field.type as NamedTypeNode;

        if (returnFieldType.name) {
          const returnTypeName = returnFieldType.name.value;

          this.extendTypeWithDirectives(ctx, returnTypeName, directives);
        }
      }
    }
  }

  private addDirectivesToField(ctx: TransformerContext, typeName: string, fieldName: string, directives: DirectiveNode[]) {
    const type = ctx.getType(typeName) as ObjectTypeDefinitionNode;

    if (type) {
      const field = type.fields.find(f => f.name.value === fieldName);

      if (field) {
        const newFields = [...type.fields.filter(f => f.name.value !== field.name.value), extendFieldWithDirectives(field, directives)];

        const newMutation = {
          ...type,
          fields: newFields,
        };

        ctx.putType(newMutation);
      }
    }
  }

  private getDirectivesForRules(rules: AuthRule[], addDefaultIfNeeded: boolean = true): DirectiveNode[] {
    if (!rules || rules.length === 0) {
      return [];
    }

    const directives: DirectiveNode[] = new Array();

    //
    // We only add a directive if it is not the default auth or
    // if it is the default one, but there are other rules for a
    // different provider.
    // For fields we don't add the default, since it would open up
    // the access rights.
    //

    const addDirectiveIfNeeded = (provider: AuthProvider, directiveName: string) => {
      if (
        (this.configuredAuthProviders.default !== provider && Boolean(rules.find(r => r.provider === provider))) ||
        (this.configuredAuthProviders.default === provider &&
          Boolean(rules.find(r => r.provider !== provider && addDefaultIfNeeded === true)))
      ) {
        directives.push(makeDirective(directiveName, []));
      }
    };

    const authProviderDirectiveMap = new Map<AuthProvider, string>([
      ['apiKey', 'aws_api_key'],
      ['iam', 'aws_iam'],
      ['oidc', 'aws_oidc'],
      ['userPools', 'aws_cognito_user_pools'],
    ]);

    for (const entry of authProviderDirectiveMap.entries()) {
      addDirectiveIfNeeded(entry[0], entry[1]);
    }

    //
    // If we've any rules for other than the default provider AND
    // we've rules for the default provider as well add the default provider's
    // directive, regardless of the addDefaultIfNeeded flag.
    //
    // For example if we've this rule and the default is API_KEY:
    //
    // @auth(rules: [{allow: owner},{allow: public, operations: [read]}])
    //
    // Then we need to add @aws_api_key on the create mutation together with the
    // @aws_cognito_user_pools, but we cannot add @aws_api_key to other operations
    // since that is not allowed by the rule.
    //

    if (
      Boolean(rules.find(r => r.provider === this.configuredAuthProviders.default)) &&
      Boolean(
        rules.find(r => r.provider !== this.configuredAuthProviders.default) &&
          !Boolean(directives.find(d => d.name.value === authProviderDirectiveMap.get(this.configuredAuthProviders.default))),
      )
    ) {
      directives.push(makeDirective(authProviderDirectiveMap.get(this.configuredAuthProviders.default), []));
    }

    return directives;
  }

  private ensureDefaultAuthProviderAssigned(rules: AuthRule[]) {
    // We assign the default provider if an override is not present make further handling easier.
    for (const rule of rules) {
      if (!rule.provider) {
        switch (rule.allow) {
          case 'owner':
          case 'groups':
            rule.provider = 'userPools';
            break;
          case 'private':
            rule.provider = 'userPools';
            break;
          case 'public':
            rule.provider = 'apiKey';
            break;
          default:
            rule.provider = null;
            break;
        }
      }
    }
  }

  private setAuthPolicyFlag(rules: AuthRule[]): void {
    if (!rules || rules.length === 0 || this.generateIAMPolicyforAuthRole === true) {
      return;
    }

    for (const rule of rules) {
      if ((rule.allow === 'private' || rule.allow === 'public') && rule.provider === 'iam') {
        this.generateIAMPolicyforAuthRole = true;
        return;
      }
    }
  }

  private setUnauthPolicyFlag(rules: AuthRule[]): void {
    if (!rules || rules.length === 0 || this.generateIAMPolicyforUnauthRole === true) {
      return;
    }

    for (const rule of rules) {
      if (rule.allow === 'public' && rule.provider === 'iam') {
        this.generateIAMPolicyforUnauthRole = true;
        return;
      }
    }
  }

  private getAuthRulesFromDirective(directive: DirectiveNode): AuthRule[] {
    const get = (s: string) => (arg: ArgumentNode) => arg.name.value === s;
    const getArg = (arg: string, dflt?: any) => {
      const argument = directive.arguments.find(get(arg));
      return argument ? valueFromASTUntyped(argument.value) : dflt;
    };

    // Get and validate the auth rules.
    return getArg('rules', []) as AuthRule[];
  }

  private isTypeHasRulesForOperation(def: ObjectTypeDefinitionNode, operation: ModelDirectiveOperationType): boolean {
    const authDirective = def.directives.find(dir => dir.name.value === 'auth');
    if (!authDirective) {
      return false;
    }

    // Get and validate the auth rules.
    const rules = this.getAuthRulesFromDirective(authDirective);
    // Assign default providers to rules where no provider was explicitly defined
    this.ensureDefaultAuthProviderAssigned(rules);

    const { operationRules, queryRules } = this.splitRules(rules);

    const hasRulesForDefaultProvider = (operationRules: AuthRule[]) => {
      return Boolean(operationRules.find(r => r.provider === this.configuredAuthProviders.default));
    };

    switch (operation) {
      case 'create':
        return hasRulesForDefaultProvider(operationRules.create);
      case 'update':
        return hasRulesForDefaultProvider(operationRules.update);
      case 'delete':
        return hasRulesForDefaultProvider(operationRules.delete);
      case 'get':
        return hasRulesForDefaultProvider(operationRules.read) || hasRulesForDefaultProvider(queryRules.get);
      case 'list':
        return hasRulesForDefaultProvider(operationRules.read) || hasRulesForDefaultProvider(queryRules.list);
    }

    return false;
  }

  private addTypeToResourceReferences(typeName: string, rules: AuthRule[]): void {
    const iamPublicRules = rules.filter(r => r.allow === 'public' && r.provider === 'iam');
    const iamPrivateRules = rules.filter(r => r.allow === 'private' && r.provider === 'iam');

    if (iamPublicRules.length > 0) {
      this.unauthPolicyResources.add(`${typeName}/null`);
      this.authPolicyResources.add(`${typeName}/null`);
    }
    if (iamPrivateRules.length > 0) {
      this.authPolicyResources.add(`${typeName}/null`);
    }
  }

  private addFieldToResourceReferences(typeName: string, fieldName: string, rules: AuthRule[]): void {
    const iamPublicRules = rules.filter(r => r.allow === 'public' && r.provider === 'iam');
    const iamPrivateRules = rules.filter(r => r.allow === 'private' && r.provider === 'iam');

    if (iamPublicRules.length > 0) {
      this.unauthPolicyResources.add(`${typeName}/${fieldName}`);
      this.authPolicyResources.add(`${typeName}/${fieldName}`);
    }
    if (iamPrivateRules.length > 0) {
      this.authPolicyResources.add(`${typeName}/${fieldName}`);
    }
  }

  private isOperationExpressionSet(operationTypeName: string, template: string): boolean {
    return template.includes(`$ctx.result.put("operation", "${operationTypeName}")`);
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
