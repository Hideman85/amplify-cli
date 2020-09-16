import { gql, InvalidDirectiveError, Transformer, TransformerContext } from 'graphql-transformer-core';
import {
  ArgumentNode,
  DirectiveNode,
  FieldDefinitionNode,
  InterfaceTypeDefinitionNode,
  ObjectTypeDefinitionNode,
  StringValueNode,
} from 'graphql';
import { ResolverResourceIDs } from 'graphql-transformer-common';
import Resolver from 'cloudform-types/types/appSync/resolver';

export class SetTransformer extends Transformer {
  constructor() {
    super(
      'SetTransformer',
      gql`directive @Set(value: String!) on FIELD_DEFINITION`,
    );
    console.info('##########################################################');
    console.info('##                   \x1b[33m@Set\x1b[37m transformer');
    console.info('##########################################################');
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

    const resourceID = ResolverResourceIDs.DynamoDBCreateResolverResourceID(obj.name.value);
    const resolver = ctx.getResource(resourceID) as Resolver;
    const arg = dir.arguments.find((arg: ArgumentNode) => arg.name.value === 'value');
    const val = (arg && arg.value) as StringValueNode;

    if (resolver && val) {
      resolver.Properties.RequestMappingTemplate = `
############################################
##  Setting property  
$util.qr($ctx.args.input.put("${def.name.value}", ${val.value}))
############################################
${resolver.Properties.RequestMappingTemplate}`;

      ctx.setResource(resourceID, resolver);
    }
  };
}

export default SetTransformer;
