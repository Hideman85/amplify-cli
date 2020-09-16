//  TS Types imports
import Maybe from 'graphql/tsutils/Maybe';
import { ArgumentNode, DirectiveNode, ObjectTypeDefinitionNode, valueFromASTUntyped } from 'graphql';
import { AuthRule, AuthRuleDirective, CreateRule, ListConfig, ListRule, Rule, SubModelConfig } from './AuthRule';
import { ModelDirectiveConfiguration, ModelDirectiveOperationType, ModelSubscriptionLevel } from './ModelDirectiveConfiguration';

//  Libs imports
import { gql, InvalidDirectiveError, Transformer, TransformerContext } from 'graphql-transformer-core';
import { ResolverResourceIDs, ResourceConstants } from 'graphql-transformer-common';
import { print, raw, RESOLVER_VERSION_ID } from 'graphql-mapping-template';
import { AppSync, CloudFormation, Fn, Template } from 'cloudform-types';
import Resolver from 'cloudform-types/types/appSync/resolver';

//  Pipeline functions imports
import { generateFunction as genGetUserData, pipelineFunctionName as getUserDataFunc } from './PipelineFunctions/FunctionGetUserData';
import { generateFunction as genParentsFunc, pipelineFunctionName as getParentsFunc } from './PipelineFunctions/FunctionBatchGetParents';
import {
  generateFunction as genCreateAdminRoleFunc,
  pipelineFunctionName as createAdminRoleFunc,
} from './PipelineFunctions/FunctionCreateInstanceAdminRole';
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
import { resolveSubModelTransitivity, transformToTransitivePipeline } from './ResolverTransformers/MakeTransitiveResolver';


//  All tables DataSource
import genAllTableDataSource from './GenerateAllTablesDataSource';

//  Resolver converters
import { converter as convertListToInstanceRoleLookup } from './ResolverTransformers/ListByInstanceRoleLookup';
import { converter as convertListToOrganisationIDLookup } from './ResolverTransformers/ListByOrganisationID';
import { converter as convertWithRoleChecking } from './ResolverTransformers/SingleActionRoleCheck';

//  Mapping template generator
import genRoleCheckMappingTemplate from './GenRoleCheckMappingTemplate';

export interface Model {
  def: ObjectTypeDefinitionNode,
  subModel: Maybe<SubModelConfig>,
  rules: Maybe<AuthRule>
}

export class ModelCustomAuthTransformer extends Transformer {
  private needPipelineFunctions: boolean = false;
  private processLater: { [key: string]: Model[] } = {};
  private modelsProceed: { [key: string]: Model } = {};

  constructor() {
    super(
      'ModelCustomAuthTransformer',
      gql`
        directive @CustomAuth(rules: [Rule_!], listConfig: ListConfig_, subModel: SubModelConfig_, autoCreateAdminRole: Boolean) on OBJECT
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
        enum SubModelKind_ {
          FULLY_TRANSITIVE
          CONDITIONALLY_TRANSITIVE
        }
        input SubModelConfig_ {
          kind: SubModelKind_!
          parentType: String!
        }
      `,
    );
    console.info('##########################################################');
    console.info('##               \x1b[33m@CustomAuth\x1b[37m transformer');
    console.info('##########################################################');
  }

  public after = (ctx: TransformerContext): void => {
    const parents = Object.keys(this.processLater);
    if (parents.length > 0) {
      parents.forEach(parentType => {
        const children = this.processLater[parentType].map(({ def }) => def.name.value);
        console.error(`Type "${parentType}" not found can't proceed to children:`, children);
      });
      throw new InvalidDirectiveError('The directive @CustomAuth must be applied to the types above.');
    }

    if (this.needPipelineFunctions) {
      genGetUserData(ctx);
      genGetUserOrganisationRole(ctx);
      genGetOtherRoles(ctx);
      genInstanceLookup(ctx);
      genInstanceBatchGet(ctx);
      genAllTableDataSource(ctx, true);
      genParentsFunc(ctx);
      genCreateAdminRoleFunc(ctx);
    }
  };


  public stack = (stackName: string, stackResource: CloudFormation.Stack, stackTemplate: Template) => {
    const functions = [
      getUserDataFunc,
      getUserOrganisationRoleFunc, getOtherRolesFunc,
      instanceLookupFunc, instanceBatchGetFunc,
      getParentsFunc,
      createAdminRoleFunc,
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

    // Get and validate the auth rules.
    const [rules, subModel] = this.getAuthRulesFromDirective(directive);

    if (subModel) {
      if (this.modelsProceed[subModel.parentType]) {
        this.processSubModel(ctx, def, subModel, rules);
      } else {
        this.processLater[subModel.parentType] = [
          ...(this.processLater[subModel.parentType] || []),
          { def, subModel, rules },
        ];
      }
    } else if (rules) {
      //  Process the model
      this.processObject(ctx, def, rules);
      this.modelsProceed[def.name.value] = { def, rules, subModel };

      //  Process eventual subModels (transitivity)
      if (Array.isArray(this.processLater[def.name.value])) {
        this.processLater[def.name.value].forEach(child => {
          this.processSubModel(ctx, child.def, child.subModel, child.rules);
        });
        delete this.processLater[def.name.value];
      }
    }
  };

  private processSubModel(ctx: TransformerContext, def: ObjectTypeDefinitionNode, subModel: SubModelConfig, rules: Maybe<AuthRule>) {
    console.info(`[SubModel]  ${subModel.kind.padEnd(25, ' ')} Child: ${def.name.value.padEnd(12, ' ')} Parent: ${subModel.parentType.padEnd(12, ' ')}`);
    if (rules && Object.keys(rules).length > 0) {
      if (subModel.kind === 'CONDITIONALLY_TRANSITIVE') {
        //  TODO: Implement
        console.warn(def.name.value, new Error('@CustomAuth with rules arg and CONDITIONALLY_TRANSITIVE subModel not implemented yet.'));
        this.processObject(ctx, def, rules);

        //  Save the model
        this.modelsProceed[def.name.value] = { def, rules, subModel };
      } else {
        throw new InvalidDirectiveError('The directive @CustomAuth with rules arg cannot be applied to a FULLY_TRANSITIVE subModel config.');
      }
    } else {
      const rootTypes = [];
      let transitivity = resolveSubModelTransitivity(def, subModel, this.modelsProceed);
      while (transitivity) {
        rootTypes.push(transitivity.types[0]);
        transitivity = transitivity.child;
      }

      ['Get', 'Create', 'Update', 'Delete'].forEach(action => {
        const resourceId = ResolverResourceIDs[`DynamoDB${action}ResolverResourceID`](def.name.value);
        const resolver = ctx.getResource(resourceId) as Resolver;
        if (resolver) {
          let roleCheck = '';
          rootTypes.map((type, index) => {
            const rootRules = this.modelsProceed[type].rules;
            const rule = rootRules[action.toLowerCase()];
            roleCheck += `
##  Role check if the type is ${type}
#${index === 0 ? '' : 'else'}if($ctx.args.input.id.startsWith("${type}-"))
${genRoleCheckMappingTemplate(rule, type).split('\n').map(str => `  ${str}`).join('\n')}
`;
          });
          resolver.Properties.RequestMappingTemplate = `
${roleCheck}
#else

  #############################################
  ##  Throw error because invalid root type  ##
  #############################################
  $util.error(
    "Input '${def.name.value}' failed to satisfy the transitivity constraint, can't find the reel root type",
    "TransitivityCheckError",
    $ctx.args.input,
    { "id": $id, "transitivity": $ctx.stash.transitivityModel }
  )

#end
${resolver.Properties.RequestMappingTemplate}
`;

          //  For create add a special check
          if (action === 'Create') {
            resolver.Properties.RequestMappingTemplate = `
############################################
##    [Start] Check & Set the rootID      ##
############################################
##  SubModel kind = ${subModel.kind}
#if(${subModel.kind === 'FULLY_TRANSITIVE' ? 'true' : '$ctx.args.input.rootID'})
  #set($ctx.args.input.rootID = $ctx.args.input.id.split("[:]")[0])
#end
############################################
##     [End] Check & Set the rootID       ##
############################################
${resolver.Properties.RequestMappingTemplate}
`;
          }

          //  Set the flag that we need pipeline functions at the end
          this.needPipelineFunctions = true;
          transformToTransitivePipeline(ctx, def, resourceId, resolver, subModel, this.modelsProceed);
        } else {
          throw new InvalidDirectiveError(`The directive @CustomAuth got an issue and can't apply the transitivity check with on the type "${def.name.value} due to the non presence of "${action}" on a parent type "${'template'}".`);
        }
      });

      //  Save the model
      this.modelsProceed[def.name.value] = { def, rules, subModel };
    }

    //  Process eventual subModels (transitivity)
    if (Array.isArray(this.processLater[def.name.value])) {
      this.processLater[def.name.value].forEach(child => {
        this.processSubModel(ctx, child.def, child.subModel, child.rules);
      });
      delete this.processLater[def.name.value];
    }
  }

  private processObject(ctx: TransformerContext, def: ObjectTypeDefinitionNode, rules: AuthRule) {
    const modelDirective = def.directives.find(dir => dir.name.value === 'model');
    // Retrieve the configuration options for the related @model directive
    const modelConfiguration = new ModelDirectiveConfiguration(modelDirective, def);

    // For each operation evaluate the rules and apply the changes to the relevant resolver.
    ['Get', 'Update', 'Delete'].forEach(action => this.protectSingleItemAction(
      ctx,
      ResolverResourceIDs[`DynamoDB${action}ResolverResourceID`](def.name.value),
      rules[action.toLowerCase()],
      def,
    ));

    // Protect the create query
    this.protectCreateAction(
      ctx,
      ResolverResourceIDs.DynamoDBCreateResolverResourceID(def.name.value),
      rules.create,
      def,
    );

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
    const searchableDirective = def.directives.find(dir => dir.name.value === 'searchable');
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
  }

  private protectSingleItemAction(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Maybe<Rule>,
    parent: ObjectTypeDefinitionNode | null,
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && resolver) {
      //  Adding role check to the current request template
      const roleCheck = genRoleCheckMappingTemplate(rule, parent.name.value);
      resolver.Properties.RequestMappingTemplate = roleCheck + resolver.Properties.RequestMappingTemplate;

      //  Set the flag that we need pipeline functions at the end
      this.needPipelineFunctions = true;
      convertWithRoleChecking(ctx, parent, resolverResourceId, resolver, rule.instanceField);
    }
  }

  private protectCreateAction(
    ctx: TransformerContext,
    resolverResourceId: string,
    rule: Maybe<CreateRule>,
    parent: ObjectTypeDefinitionNode | null,
  ) {
    const resolver = ctx.getResource(resolverResourceId) as Resolver;
    if (rule && resolver) {
      //  Adding role check to the current request template
      const roleCheck = genRoleCheckMappingTemplate(rule, parent.name.value);
      resolver.Properties.RequestMappingTemplate = roleCheck + resolver.Properties.RequestMappingTemplate;

      const extraFunctions = [
        Fn.Ref(`${createAdminRoleFunc}Param`),
      ];

      //  Set the flag that we need pipeline functions at the end
      this.needPipelineFunctions = true;
      convertWithRoleChecking(ctx, parent, resolverResourceId, resolver, rule.instanceField, extraFunctions);
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
        this.needPipelineFunctions = true;
        convertListToInstanceRoleLookup(ctx, resolverResourceId, resolver, rule, parent);
      } else if (rule.listConfig.kind === 'LIST_BY_ORGANISATION_ID') {
        //  Set the flag that we need pipeline functions at the end
        this.needPipelineFunctions = true;
        convertListToOrganisationIDLookup(ctx, resolverResourceId, resolver, rule, parent);
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

  private getAuthRulesFromDirective(directive: DirectiveNode): [Maybe<AuthRule>, Maybe<SubModelConfig>] {
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

    const autoCreateAdminRole = getArg('autoCreateAdminRole', undefined) as boolean;
    if (mappedRules.create && autoCreateAdminRole !== undefined) {
      mappedRules.create.autoCreateAdminRole = autoCreateAdminRole;
    }

    const subModel = getArg('subModel') as SubModelConfig;
    return [mappedRules, subModel];
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
