import {ResourceFactory} from './resources'

class ResourceFactoryOverride extends ResourceFactory {
  protected dynamoDBTableName(typeName: string): IntrinsicFunction {
    return Fn.If(
      ResourceConstants.CONDITIONS.HasEnvironmentParameter,
      Fn.Join('-', [
        Fn.Ref(ResourceConstants.PARAMETERS.Env),
        typeName,
      ]),
      typeName,
    );
  }
}
