import {gql, InvalidDirectiveError, Transformer, TransformerContext} from 'graphql-transformer-core'
import {AuthRule, AuthRuleDirective, Rule} from './AuthRule'
import {ArgumentNode, DirectiveNode, ObjectTypeDefinitionNode, valueFromASTUntyped} from 'graphql'
import {ResolverResourceIDs, ResourceConstants} from 'graphql-transformer-common'
import {Expression, print, raw, RESOLVER_VERSION_ID} from 'graphql-mapping-template'
import {ModelDirectiveConfiguration, ModelDirectiveOperationType, ModelSubscriptionLevel} from './ModelDirectiveConfiguration'
import {AppSync, Fn, CloudFormation, Template} from 'cloudform-types'
import Resolver, {PipelineConfig} from 'cloudform-types/types/appSync/resolver'
import {generateFunction as genRoleCheckFunc1, pipelineFunctionName as roleCheckFunc1Name} from './Function1GetUserOrganisationRole'
import {generateFunction as genRoleCheckFunc2, pipelineFunctionName as roleCheckFunc2Name} from './Function2BatchGetOtherRoles'
import {type} from 'os'

export class ModelCustomAuthTransformer extends Transformer {
  private needPipelineFunctions: boolean = false;

  constructor() {
    super(
      'ModelCustomAuthTransformer',
      gql`
        directive @CustomAuth(rules: [Rule_!]!) on OBJECT
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
      `,
    );
  }

  public after = (ctx: TransformerContext): void => {
    if (this.needPipelineFunctions) {
      //  Firstly generates the two functions in their stack named RoleChecking
      genRoleCheckFunc1(ctx)
      genRoleCheckFunc2(ctx)
    }
  }


  public stack = (stackName: string, stackResource: CloudFormation.Stack, stackTemplate: Template) => {
    if (this.needPipelineFunctions) {
      if (stackName === 'RoleChecking') {
        //  Exports needed variables
        [roleCheckFunc1Name, roleCheckFunc2Name].forEach(output => {
          stackTemplate.Outputs[output] = { Value: Fn.Ref(output) };
        });
      } else {
        //  Add parameters
        [roleCheckFunc1Name, roleCheckFunc2Name].forEach(output => {
          stackTemplate.Parameters[output] = { Type: 'String' };
          stackResource.Properties.Parameters[output] = Fn.GetAtt(
            'RoleChecking',
            `Outputs.${output}`
          );
        });
      }
    }
  }

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
      modelConfiguration,
    ));

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
    modelConfiguration: ModelDirectiveConfiguration,
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && resolver) {
      //  Adding role check to the current request template
      const roleCheck = this.genRoleCheckTemplate(rule, parent.name.value)
      resolver.Properties.RequestMappingTemplate = roleCheck + resolver.Properties.RequestMappingTemplate

      //  Converting into pipeline resolver
      this.convertToPipelineResolver(ctx, parent, resolverResourceId, resolver, rule.instanceField)
    }
  }

  private genRoleCheckTemplate(rule: Rule, modelName: string) {
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
#elif($ctx.stash.instanceTeamRole)
  #set($role = $ctx.stash.instanceTeamRole.role)
#elif($ctx.stash.instanceOrganisationRole)
  #set($role = $ctx.stash.instanceOrganisationRole.role)
#end

##  Checking the role
#if(!$allowedRoles.contains($role))
  $util.unauthorized()
#end
############################################
##           [End] Role check             ##
############################################
`
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
#elif($ctx.stash.organisationTeamRole)
  #set($role = $ctx.stash.organisationTeamRole.${modelName.toLowerCase()}Role)
#end

##  Checking the role
#if(!$allowedRoles.contains($role))
  $util.unauthorized()
#end
############################################
##           [End] Role check             ##
############################################
`
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
`
    }
  }

  private protectListQuery(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Rule,
    parent: ObjectTypeDefinitionNode | null,
    modelConfiguration: ModelDirectiveConfiguration,
    explicitOperationName: string = undefined,
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && resolver) {
      const authExpression = this.authorizationExpressionForListResult(rule);
      if (authExpression) {
        // TODO: Implement
        this.convertToPipelineResolver(ctx, parent, resolverResourceId, resolver, rule.instanceField)
      }
    }
  }

  private authorizationExpressionForListResult(rule: Rule, itemList: string = 'ctx.result.items'): Expression {
    //  TODO: Implement resolver mapping template
    return null
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
    rule: Rule
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && resolver) {
      const authExpression = this.authorizationExpressionForListResult(rule);
      if (authExpression) {
        // TODO: Implement
        this.convertToPipelineResolver(ctx, parent, resolverResourceId, resolver, rule.instanceField)
      }
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
      if (level === 'public') {
        // set the resource with no auth logic
        ctx.setResource(resolverResourceId, resolver);
      } else {
        // TODO: Implement subscription authorization resolver (should be transformed into pipeline resolver)
        this.convertToPipelineResolver(ctx, parent, resolverResourceId, resolver, rule.instanceField)
      }
      // If the subscription level is set to public it adds the subscription resolver with no auth logic
      if (!noneDS) {
        ctx.setResource(ResourceConstants.RESOURCES.NoneDataSource, this.noneDataSource());
      }
      // finally map the resource to the stack
      ctx.mapResourceToStack(parent.name.value, resolverResourceId);
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
    const mappedRules : AuthRule = {} as AuthRule;

    rules.forEach(rule => {
      rule.actions.forEach(action => {
        mappedRules[action.toLocaleLowerCase()] = { kind: rule.kind, allowedRoles: rule.allowedRoles, instanceField: rule.instanceField };
      })
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

  private convertToPipelineResolver(
    ctx: TransformerContext,
    parent: ObjectTypeDefinitionNode,
    resourceId: string,
    resolver: Resolver,
    instanceID: string = 'id'
  ) {
    //  Set the flag that we need pipeline functions at the end
    this.needPipelineFunctions = true

    const before = `
############################################
##      [Start] Stashing needed stuff     ##
############################################
${instanceID ? `$util.qr($ctx.stash.put("instanceID", $ctx.args.input.${instanceID}))` : '## No instanceID set'}
$util.qr($ctx.stash.put("userID", $ctx.identity.sub))
$util.qr($ctx.stash.put("organisationID", $ctx.identity.claims["custom:currentOrganisation"]))
############################################
##       [End] Stashing needed stuff      ##
############################################ 
`
    const after = `
############################################
##      [Start] Simple error check        ##
############################################
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type, $ctx.result)
#else
  $util.toJson($ctx.result)
#end
############################################
##       [End] Simple error check         ##
############################################
`
    //  Define and assemble pipeline function
    const pipelineFunctionID = `${resourceId}PipelineFunction`
    const pipelineFunction = new AppSync.FunctionConfiguration({
      ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
      DataSourceName: resolver.Properties.DataSourceName,
      RequestMappingTemplate: resolver.Properties.RequestMappingTemplate,
      ResponseMappingTemplate: resolver.Properties.ResponseMappingTemplate,
      Name: pipelineFunctionID,
      FunctionVersion: RESOLVER_VERSION_ID
    })

    //  Map the new resource
    ctx.setResource(pipelineFunctionID, pipelineFunction);
    ctx.mapResourceToStack(parent.name.value, pipelineFunctionID);

    //  Rewrite the resolver into pipeline resolver
    resolver.Properties.DataSourceName = undefined
    resolver.Properties.RequestMappingTemplate = before
    resolver.Properties.ResponseMappingTemplate = after
    resolver.Properties.Kind = 'PIPELINE'
    resolver.Properties.PipelineConfig = new PipelineConfig({
      Functions: [
        Fn.Ref(roleCheckFunc1Name),
        Fn.Ref(roleCheckFunc2Name),
        Fn.GetAtt(pipelineFunctionID, 'FunctionId')
      ]
    })

    //  The resolver need to wait the creation of the pipeline function
    if (typeof resolver.DependsOn === 'string') {
      resolver.DependsOn = [resolver.DependsOn]
    } else if (!Array.isArray(resolver.DependsOn)) {
      resolver.DependsOn = []
    }
    resolver.DependsOn.push(pipelineFunctionID)

    //  Save back the resolver
    ctx.setResource(resourceId, resolver);
  }
}

export default ModelCustomAuthTransformer
