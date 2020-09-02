import {gql, Transformer, TransformerContext, InvalidDirectiveError} from 'graphql-transformer-core'
import {
  ArgumentNode,
  DirectiveNode,
  FieldDefinitionNode,
  InterfaceTypeDefinitionNode,
  ObjectTypeDefinitionNode,
  ListValueNode,
  StringValueNode
} from 'graphql'
import {ResolverResourceIDs} from 'graphql-transformer-common'
import Resolver from 'cloudform-types/types/appSync/resolver'

const valueMapping = {
  null: '{ "attributeExists": false }',
  notnull: '{ "attributeExists": true }'
}

export class CheckTransformer extends Transformer {
  constructor() {
    super(
      'CheckTransformer',
      gql`directive @Check(values: [String!]!) on FIELD_DEFINITION`
    );
  }

  private transformValue(value: string) {
    if (valueMapping[value]) {
      return valueMapping[value]
    } else {
      return `{ "eq": ${value} }`
    }
  }

  public field = (
    obj: ObjectTypeDefinitionNode | InterfaceTypeDefinitionNode,
    def: FieldDefinitionNode,
    dir: DirectiveNode,
    ctx: TransformerContext
  ) => {
    const modelDirective = obj.directives.find(dir => dir.name.value === 'model');
    if (!modelDirective) {
      throw new InvalidDirectiveError('Types annotated with @CustomAuth must also be annotated with @model.');
    }

    ['Get', 'Create', 'Update', 'Delete'].forEach(resolverName => {
      const resourceID = ResolverResourceIDs[`DynamoDB${resolverName}ResolverResourceID`](obj.name.value)
      const resolver = ctx.getResource(resourceID) as Resolver;
      const arg = dir.arguments.find((arg: ArgumentNode) => arg.name.value === 'values')
      const val = (arg && arg.value) as ListValueNode

      if (resolver && val) {
        const values = val.values as StringValueNode[]

        if (resolverName !== 'Delete') {
          const conds = values.map(string => string.value)

          resolver.Properties.RequestMappingTemplate = `
############################################
##  [Start] Build Input check condition   ##
############################################
#set($value = $util.defaultIfNull($ctx.args.input.${def.name.value}, null))
#set($allowedValues = [
  ${conds.join(',\n  ')}
])
#if(!$allowedValues.contains($value))
  $util.unauthorized()
#end
############################################
##   [End] Build Input check condition    ##
############################################
${resolver.Properties.RequestMappingTemplate}`
        }

        if (resolverName !== 'Create') {
          const conds = values.map(string => `{ "${def.name.value}": ${this.transformValue(string.value)} }`)

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
${resolver.Properties.RequestMappingTemplate}`
        }
        ctx.setResource(resourceID, resolver)
      }
    })
  }
}

export default CheckTransformer
