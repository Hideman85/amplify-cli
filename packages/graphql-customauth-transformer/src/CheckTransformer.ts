import { gql, InvalidDirectiveError, Transformer, TransformerContext } from 'graphql-transformer-core';
import {
  ArgumentNode,
  DirectiveNode,
  FieldDefinitionNode,
  InterfaceTypeDefinitionNode,
  ListValueNode,
  ObjectTypeDefinitionNode,
  StringValueNode,
} from 'graphql';
import { ResolverResourceIDs } from 'graphql-transformer-common';
import Resolver from 'cloudform-types/types/appSync/resolver';

const valueMapping = {
  null: '{ "attributeExists": false }',
  notnull: '{ "attributeExists": true }',
};

export class CheckTransformer extends Transformer {
  constructor() {
    super(
      'CheckTransformer',
      gql`directive @Check(values: [String!]!) on FIELD_DEFINITION`,
    );
    console.info('##########################################################');
    console.info('##                  \x1b[33m@Check\x1b[37m transformer');
    console.info('##########################################################');
  }

  private transformValue(value: string) {
    if (valueMapping[value]) {
      return valueMapping[value];
    } else {
      return `{ "eq": ${value} }`;
    }
  }

  public field = (
    obj: ObjectTypeDefinitionNode | InterfaceTypeDefinitionNode,
    def: FieldDefinitionNode,
    dir: DirectiveNode,
    ctx: TransformerContext,
  ) => {
    const modelDirective = obj.directives.find(dir => dir.name.value === 'model');
    if (!modelDirective) {
      throw new InvalidDirectiveError('Types annotated with @CustomAuth must also be annotated with @model.');
    }

    ['Get', 'Create', 'Update', 'Delete'].forEach(resolverName => {
      const resourceID = ResolverResourceIDs[`DynamoDB${resolverName}ResolverResourceID`](obj.name.value);
      const resolver = ctx.getResource(resourceID) as Resolver;
      const arg = dir.arguments.find((arg: ArgumentNode) => arg.name.value === 'values');
      const val = (arg && arg.value) as ListValueNode;

      if (resolver && val) {
        const values = val.values as StringValueNode[];

        if (resolverName !== 'Delete') {
          const conds = values.map(string => string.value === 'null' ? '$null' : string.value);

          resolver.Properties.RequestMappingTemplate = `
############################################
##  [Start] Build Input check condition   ##
############################################
## Set vars
#set($null = "__NULL__")
#set($value = $ctx.args.input.${def.name.value})
#set($allowedValues = [
  ${conds.join(',\n  ')}
])
## Set default value if null
#if($util.isString($value))
  #set($value = $util.defaultIfNullOrEmpty($value, $null))
#else
  #set($value = $util.defaultIfNull($value, $null))
#end
## Check value
#if(!$allowedValues.contains($value))
  $util.error(
    "Input '${def.name.value}' failed to satisfy the constraint",
    "InputCheckError",
    $ctx.args.input,
    { "allowedValues": $allowedValues, "inputValue": $value }
  )
#end
############################################
##   [End] Build Input check condition    ##
############################################
${resolver.Properties.RequestMappingTemplate}`;
        }

        if (resolverName !== 'Create') {
          const conds = values.map(string => string.value === 'null'
            ? `{ "${def.name.value}": { "attributeExists": false } }`
            : `{ "${def.name.value}": { "eq": ${this.transformValue(string.value)} } }`,
          );

          resolver.Properties.RequestMappingTemplate = `
############################################
##   [Start] Build DB check condition     ##
############################################
#set($checkCondition = {
  "or": [
    ${conds.join(',\n    ')}
  ]
})
#if($ctx.args.condition)
  #set($ctx.args.condition = { "and": [$ctx.args.condition, $checkCondition] })
#else
  #set($ctx.args.condition = $checkCondition)
#end
############################################
##    [End] Build DB check condition      ##
############################################
${resolver.Properties.RequestMappingTemplate}`;
        }
        ctx.setResource(resourceID, resolver);
      }
    });
  };
}

export default CheckTransformer;
