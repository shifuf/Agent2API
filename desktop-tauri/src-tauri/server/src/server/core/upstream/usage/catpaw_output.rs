use std::sync::{atomic::Ordering, Arc};

use agent2api_provider_protocol::WireError;

use crate::server::core::plugin_host::wasm::{
    catpaw_output_unconfirmed as unconfirmed, CatPawOutputGuard as OutputGuard,
    CatPawOutputSlot as OutputSlot,
};

impl super::RequestTelemetry {
    /// Called only at the actual host rewrite boundary, with the selected
    /// untouched source and the public model from trusted request routing.
    /// The final output guard remains owned by the downstream consumer.
    pub(in crate::server::core::upstream) fn project_catpaw_model(&self, outcome: crate::server::core::upstream::ForwardOutcome, requested: &str)
        -> Result<crate::server::core::upstream::ForwardOutcome, crate::server::errors::GatewayError> {
        use crate::server::core::upstream::ForwardOutcome;
        let project = || -> Result<_, WireError> {
            let slot = self.catpaw_output.try_lock().map_err(|_| unconfirmed())?;
            if self.catpaw_output_taken.load(Ordering::Acquire) { return Err(unconfirmed()); }
            Ok(slot.clone())
        };
        let map_error = |_: WireError| {
            let mut error = crate::server::errors::GatewayError::with_status(502, "CatPaw 原输出与公共模型投影未完整核对")
                .with_code("catpaw_output_unconfirmed");
            error.retry_forbidden = true;
            error
        };
        let Some(slot) = project().map_err(map_error)? else { return Ok(outcome) };
        match outcome {
            ForwardOutcome::Stream { status, stream } => Ok(ForwardOutcome::Stream {
                status, stream: slot.project_stream(stream, requested).map_err(map_error)?,
            }),
            ForwardOutcome::Completion { body } => {
                slot.project_completion(&body, requested).map_err(map_error)?;
                Ok(ForwardOutcome::Completion { body })
            }
            ForwardOutcome::Native(_) => Err(map_error(unconfirmed())),
        }
    }

    pub(crate) fn install_catpaw_output(&self, output: Arc<OutputSlot>) -> Result<(), WireError> {
        if self.catpaw_output_taken.load(Ordering::Acquire) { return Err(unconfirmed()); }
        let mut deferred = None;
        let result = (|| {
            let mut slot = self.catpaw_output.try_lock().map_err(|_| unconfirmed())?;
            if self.catpaw_output_taken.load(Ordering::Acquire) { return Err(unconfirmed()); }
            if slot.as_ref().is_some_and(|old| !old.replaceable()) { return Err(unconfirmed()); }
            deferred = slot.replace(output);
            Ok(())
        })();
        drop(deferred);
        result
    }

    pub(crate) fn take_catpaw_output(&self) -> Result<Option<OutputGuard>, WireError> {
        if self.catpaw_output_taken.load(Ordering::Acquire) {
            return Err(unconfirmed());
        }
        let slot = {
            let mut slot = self.catpaw_output.try_lock().map_err(|_| unconfirmed())?;
            if self.catpaw_output_taken.load(Ordering::Acquire) { return Err(unconfirmed()); }
            if slot.is_none() { return Ok(None); }
            if self.catpaw_output_taken.swap(true, Ordering::AcqRel) {
                return Err(unconfirmed());
            }
            slot.take()
        };
        match slot {
            Some(slot) => slot.take(),
            None => Ok(None),
        }
    }
}
