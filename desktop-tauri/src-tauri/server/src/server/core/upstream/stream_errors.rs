//! Keep host failures typed until routing and aggregation have finished.
//! Public SSE never carries the internal retry or conversation classification.

use bytes::Bytes;
use futures::{stream::BoxStream, StreamExt};

use crate::server::errors::GatewayError;

type Source = BoxStream<'static, Result<Bytes, std::io::Error>>;

pub(super) fn gateway(error: &std::io::Error) -> Option<GatewayError> {
    error.get_ref()?.downcast_ref::<GatewayError>().cloned()
}

/// Called only after the client has selected a final streaming response.
pub(super) fn public(source: Source) -> Source {
    futures::stream::unfold(Some(source), |mut source| async move {
        let item = source.as_mut()?.next().await?;
        let item = match item {
            Err(error) => match gateway(&error) {
                Some(failure) => {
                    let mut frame = super::sse::sse_frame(&failure.payload()).to_vec();
                    frame.extend_from_slice(b"data: [DONE]\n\n");
                    // Dropping the original source also releases its host lease.
                    source.take();
                    Ok(Bytes::from(frame))
                }
                None => Err(error),
            },
            item => item,
        };
        Some((item, source))
    }).boxed()
}
