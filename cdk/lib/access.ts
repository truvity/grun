import { CfnOutput, Stack, aws_apigateway as apigateway, aws_certificatemanager as acm, aws_lambda as lambda, aws_s3 as s3 } from 'aws-cdk-lib';
import { LambdaAccess } from '@cloudsnorkel/cdk-github-runners';
import { Construct } from 'constructs';

export interface CustomDomainAccessProps {
  readonly domainName: string;
  readonly certificateArn: string;
  /** Trust store for client certificates: the Cloudflare origin-pull CA bundle. */
  readonly truststore: { readonly bucket: string; readonly key: string; readonly version?: string };
  /** Prefix for the output names, so several organisations do not collide. */
  readonly outputPrefix: string;
}

/**
 * Webhook access through an API Gateway REST API on a custom domain that
 * demands a client certificate (mutual TLS), with the default execute-api
 * endpoint switched off.
 *
 * cdk-github-runners' own LambdaAccess.apiGateway() has no custom domain and
 * no mTLS, but LambdaAccess is an abstract class meant to be implemented, and
 * the webhook function only needs API Gateway proxy events under the URL
 * returned from bind(). This is the smallest extension that fits.
 *
 * Cloudflare Authenticated Origin Pulls (global mode) presents Cloudflare's
 * shared client certificate; the truststore holds the CA that signed it, so
 * a request that did not come through Cloudflare never reaches the Lambda.
 * GitHub's HMAC signature check in the function stays as the second layer.
 *
 * DNS is not managed here: the stack prints the regional domain name the
 * Cloudflare record must point to.
 */
export class CustomDomainApiAccess extends LambdaAccess {
  constructor(private readonly props: CustomDomainAccessProps) {
    super();
  }

  public bind(scope: Construct, id: string, lambdaFunction: lambda.Function): string {
    const { props } = this;
    const stack = Stack.of(scope);
    const certificate = acm.Certificate.fromCertificateArn(scope, `${id}Certificate`, props.certificateArn);
    const truststore = s3.Bucket.fromBucketName(scope, `${id}Truststore`, props.truststore.bucket);

    const api = new apigateway.LambdaRestApi(scope, id, {
      handler: lambdaFunction,
      proxy: true,
      cloudWatchRole: false,
      disableExecuteApiEndpoint: true,
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      domainName: {
        domainName: props.domainName,
        certificate,
        endpointType: apigateway.EndpointType.REGIONAL,
        securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
        mtls: {
          bucket: truststore,
          key: props.truststore.key,
          version: props.truststore.version,
        },
      },
    });
    // The default Endpoint output would print the disabled execute-api URL.
    api.node.tryRemoveChild('Endpoint');

    const domain = api.domainName;
    if (!domain) throw new Error('custom domain was not created');
    new CfnOutput(stack, `${props.outputPrefix}RegionalDomainName`, {
      description: `Point the DNS record of ${props.domainName} here (proxied, with origin pulls).`,
      value: domain.domainNameAliasDomainName,
    });
    return `https://${props.domainName}/`;
  }
}
