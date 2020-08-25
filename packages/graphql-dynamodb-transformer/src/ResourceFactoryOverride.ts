import {ResourceFactory} from './resources'
import { ResourceConstants } from 'graphql-transformer-common';
import {Fn, IntrinsicFunction} from 'cloudform-types'

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
