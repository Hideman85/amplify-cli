import {gql, Transformer, TransformerContext, InvalidDirectiveError} from 'graphql-transformer-core'
import {
  ArgumentNode,
  DirectiveNode,
  FieldDefinitionNode,
  InterfaceTypeDefinitionNode,
  ObjectTypeDefinitionNode,
  BooleanValueNode
} from 'graphql'
import {ResolverResourceIDs} from 'graphql-transformer-common'
import Resolver from 'cloudform-types/types/appSync/resolver'

const valueMapping = {
  null: '{ "attributeExists": false }',
  notnull: '{ "attributeExists": true }'
}

export class ReadOnlyTransformer extends Transformer {
  constructor() {
    super(
      'ReadOnlyTransformer',
      gql`directive @ReadOnly(allowSetWhenEmpty: Boolean) on FIELD_DEFINITION`
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

    const resourceID = ResolverResourceIDs.DynamoDBUpdateResolverResourceID(obj.name.value)
    const resolver = ctx.getResource(resourceID) as Resolver;
    const arg = dir.arguments.find((arg: ArgumentNode) => arg.name.value === 'allowSetWhenEmpty')
    const allowSetWhenEmpty = (arg && arg.value) as BooleanValueNode

    if (resolver) {
      resolver.Properties.RequestMappingTemplate = `
############################################
##  [Start] Build DB ReadOnly condition   ##
############################################
#set($checkCondition = {
  "${def.name.value}": {
    "eq": $ctx.args.input.${def.name.value}
  }
})
${(allowSetWhenEmpty && allowSetWhenEmpty.value) ? `
#set($checkCondition = {
  "or": [$checkCondition, {
    "${def.name.value}": { "attributeExists": false }
  }]
})
` : ''}
#if($ctx.args.condition)
  #set($ctx.args.condition = { "and": [$ctx.args.condition, $checkCondition] })
#else
  #set($ctx.args.condition = $checkCondition)
#end
############################################
##   [End] Build DB ReadOnly condition    ##
############################################
${resolver.Properties.RequestMappingTemplate}`

      ctx.setResource(resourceID, resolver)
    }
  }
}

export default ReadOnlyTransformer
