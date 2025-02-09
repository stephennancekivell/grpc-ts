import { isFunction, isObject, isPresent, isString, isText } from '@whisklabs/typeguards';

import { Decode, Encode } from '../binary';
import { Field, FieldGet, Service, ServiceRequest, ServiceResponse } from '../types';
import { send } from './devtool';
import { maskWrap } from './mask';
import { Chunk, ChunkType, chunkParse } from './parser';
import { StatusCode, fromHttpStatus } from './status';
import { Cancel, ConfigGRPC, GError, GOutput, GRPC, LocalGRPC } from './types';
import { GRPC_MESSAGE, GRPC_STATUS, bufToString, encodeRequest, safeJSON, toInt8 } from './utils';

export const grpcCancel = (): Cancel => {
  const CancelFn = (() => {
    CancelFn.abort?.();
    CancelFn.abort = undefined;
  }) as Cancel;

  return CancelFn;
};

export const grpcHTTP = <Meta = unknown>({
  server,
  transformRequest,
  transformResponse,
  credentials = true,
  timeout: timeoutConfig,
  devtool = false,
  debug = false,
  logger,
}: ConfigGRPC<Meta>) => {
  if (!isText(server)) {
    throw new Error('No "server" in GRPC config');
  }

  const cancels: Record<string, () => void> = {};

  return (<T extends Field, K extends Field>(
    field: Service<T, K>,
    values = {} as ServiceRequest<Service<T, K>>,
    { cancel, onDownload, onUpload, mask, timeout, meta }: LocalGRPC<T, Meta> = {}
  ): Promise<GOutput<ServiceResponse<Service<T, K>>>> => {
    if (isString(cancel) && isFunction(cancels[cancel])) {
      cancels[cancel]();
      delete cancels[cancel];
    }

    const method = `${server}/${field.name}`;
    const xhr = new XMLHttpRequest();

    xhr.timeout = timeout ?? timeoutConfig ?? 0;

    const abortXHR = () => xhr.abort();

    if (isPresent(cancel)) {
      if (isString(cancel)) {
        cancels[cancel] = abortXHR;
      } else {
        cancel.abort = abortXHR;
      }
    }

    const tmCancel = () => {
      if (isPresent(cancel)) {
        if (isString(cancel)) {
          delete cancels[cancel];
        } else {
          cancel.abort = undefined;
        }
      }
    };

    let sendData: FieldGet<T> = values;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
    return new Promise<GOutput<ServiceResponse<Service<T, K>>>>(async callback => {
      xhr.open('POST', method);

      xhr.withCredentials = credentials;

      if ('overrideMimeType' in xhr) {
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
      }

      xhr.responseType = 'arraybuffer';

      xhr.setRequestHeader('content-type', 'application/grpc-web+proto');
      xhr.setRequestHeader('x-grpc-web', '1');
      xhr.setRequestHeader('x-user-agent', 'grpc-web-ts/1.0');

      if (isFunction(onDownload)) {
        xhr.addEventListener('progress', onDownload);
      }

      if (isFunction(onUpload) && isObject(xhr.upload)) {
        xhr.upload.addEventListener('progress', onUpload);
      }

      xhr.addEventListener('timeout', () => {
        tmCancel();
        callback({ success: false, error: { message: 'timeout', data: xhr.timeout } });
      });

      xhr.addEventListener('abort', () => {
        tmCancel();
        callback({
          success: false,
          error: { message: 'cancelled', httpStatus: xhr.status, grpcCode: StatusCode.CANCELLED },
        });
      });

      xhr.addEventListener('error', () => {
        tmCancel();
        callback({
          success: false,
          error: {
            message: 'XHR error',
            data: bufToString(xhr),
            httpStatus: xhr.status,
            grpcCode: fromHttpStatus(xhr.status),
          },
        });
      });

      xhr.addEventListener('load', function onready() {
        tmCancel();

        if (xhr.status < 200 || xhr.status >= 300) {
          return callback({
            success: false,
            error: {
              message: 'XHR wrong status',
              data: bufToString(xhr),
              httpStatus: xhr.status,
              grpcCode: fromHttpStatus(xhr.status),
            },
          });
        }

        const byteSource = toInt8(xhr);

        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if (!byteSource) {
          return callback({ success: false, error: { message: 'GRPC no bytes' } });
        }

        let data: Chunk[] = [];

        try {
          data = chunkParse(byteSource);
        } catch (error) {
          return callback({ success: false, error: { message: 'GRPC parsing error', data: error } });
        }

        if (data.length === 0) {
          const status = this.getResponseHeader(GRPC_STATUS);
          const message = isPresent(status)
            ? this.getResponseHeader(GRPC_MESSAGE) ?? ''
            : 'Failed to parse GRPC status';
          const grpcCode = isPresent(status) ? Number(status) ?? 0 : undefined;

          return callback({
            success: false,
            error: { message, data: safeJSON(message), httpStatus: xhr.status, grpcCode },
          });
        }

        for (const d of data) {
          if (d.chunkType === ChunkType.MESSAGE) {
            try {
              if (debug) {
                send({
                  method,
                  methodType: 'server_streaming',
                  response: [].slice.call(byteSource),
                });
                logger?.warn(method, byteSource);
              }
              return callback({ success: true, data: Decode(field.decode, d.data) });
            } catch (e) {
              return callback({
                success: false,
                error: { message: 'Decode error', data: e, httpStatus: xhr.status },
              });
            }
          } else if (d.chunkType === ChunkType.TRAILERS) {
            const trailers = d.trailers;
            let grpcCode: number = StatusCode.OK;

            const message = trailers[GRPC_MESSAGE] ?? '';
            const status = trailers?.[GRPC_STATUS];

            if (isString(status)) {
              const code = Number(status);
              grpcCode = code >= 0 ? code : fromHttpStatus(xhr.status);
            }

            return callback({
              success: false,
              error: { message, data: safeJSON(message), httpStatus: xhr.status, grpcCode },
            });
          }
        }
      });

      if (isFunction(transformRequest)) {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        sendData = (await transformRequest({ xhr, data: values, meta })) || values;
      }

      const encoded = Encode(
        field.encode,
        mask === true
          ? maskWrap(sendData)
          : isObject(mask) && isText(mask.field)
          ? maskWrap(sendData, mask.field, mask.outField)
          : sendData
      );
      const request = encodeRequest(encoded);

      if (debug) {
        send({
          method,
          methodType: 'server_streaming',
          request: [].slice.call(request),
        });
        logger?.warn(method, request);
      }

      xhr.send(request);
    })
      .then(data => {
        if (devtool) {
          send({
            method,
            methodType: 'unary',
            request: sendData,
            response: data.success ? data.data : undefined,
            error: data.success ? undefined : data.error,
          });
          logger?.[data.success ? 'info' : 'error'](method, sendData, data);
        }

        return data;
      })
      .then(data => (isFunction(transformResponse) ? transformResponse({ xhr, data, meta }) : data))
      .catch(data => {
        logger?.error(method, data);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        return { success: false, error: { data } } as GError;
      });
  }) as GRPC<Meta>;
};
