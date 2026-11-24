//! A trusted host model rewrite has two observations: the exact original source
//! and the final projected output. Only the latter can complete the output slot.

use std::{io, pin::Pin, task::{Context, Poll}};

use super::*;

pub(super) struct ModelProjection {
    requested: String,
    pub(super) original: Option<OutputObservation>,
}

impl ModelProjection {
    pub(super) fn verify(&self, binding: &Binding, final_output: &OutputObservation) -> Result<(), proto::WireError> {
        let original = self.original.as_ref().ok_or_else(unconfirmed)?;
        // Revalidate the live original reservation, including its unmodified
        // model/id/created/source/record/sequence, after final consumption too.
        binding.verify(original)?;
        let mut expected = original.chat_body();
        expected["model"] = self.requested.clone().into();
        if final_output.chat_body() != expected { return Err(unconfirmed()); }
        binding.expected.verify(final_output)
    }
}

impl OutputSlot {
    fn begin_projection(&self, requested: &str) -> Result<(), proto::WireError> {
        let result = (|| {
            if requested.is_empty() || requested.len() > 1024 || requested.trim() != requested
                || requested.chars().any(char::is_control) { return Err(unconfirmed()); }
            let mut state = self.state.try_lock().map_err(|_| unconfirmed())?;
            if !state.selected || state.guard_issued || state.projection.is_some()
                || state.output != OutputState::Pending || state.observation.is_some() || state.body_ended {
                return Err(unconfirmed());
            }
            state.projection = Some(ModelProjection { requested: requested.into(), original: None });
            Ok(())
        })();
        if result.is_err() { self.fail(); }
        result
    }

    fn observe_original(&self, original: OutputObservation) -> Result<(), proto::WireError> {
        let result = (|| {
            let mut state = self.state.try_lock().map_err(|_| unconfirmed())?;
            if state.output == OutputState::Failed || state.body_ended || state.observation.is_some()
                || state.projection.as_ref().is_none_or(|projection| projection.original.is_some()) {
                return Err(unconfirmed());
            }
            if let Some(binding) = &state.binding { binding.verify(&original)?; }
            state.projection.as_mut().ok_or_else(unconfirmed)?.original = Some(original);
            // No final observation, output-state transition or body completion.
            Ok(())
        })();
        if result.is_err() { self.fail(); }
        result
    }

    /// The caller must pass the untouched selected source, before its existing
    /// trusted ModelRewrite. This neither takes nor finishes the final guard.
    pub(in crate::server) fn project_stream(self: &Arc<Self>, source: ChatStream, requested: &str)
        -> Result<ChatStream, proto::WireError> {
        self.begin_projection(requested)?;
        Ok(Box::new(OriginalStream { source, slot: self.clone(), observer: Some(OutputObserver::new()), ended: false }))
    }

    /// Observe the untouched complete body before the host changes only model.
    pub(in crate::server) fn project_completion(&self, body: &Value, requested: &str) -> Result<(), proto::WireError> {
        self.begin_projection(requested)?;
        let result = (|| {
            let mut observer = OutputObserver::new();
            observer.observe_body(body)?;
            self.observe_original(observer.finish()?)
        })();
        if result.is_err() { self.fail(); }
        result
    }
}

struct OriginalStream {
    source: ChatStream,
    slot: Arc<OutputSlot>,
    observer: Option<OutputObserver>,
    ended: bool,
}

impl futures::Stream for OriginalStream {
    type Item = Result<bytes::Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ended { return Poll::Ready(None); }
        match Pin::new(&mut self.source).poll_next(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(bytes))) => {
                if self.observer.as_mut().is_none_or(|observer| observer.push(&bytes).is_err()) {
                    self.slot.fail(); self.ended = true;
                    Poll::Ready(Some(Err(invalid())))
                } else { Poll::Ready(Some(Ok(bytes))) }
            }
            Poll::Ready(Some(Err(error))) => {
                self.slot.fail(); self.ended = true;
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                self.ended = true;
                let result = self.observer.take().ok_or_else(unconfirmed)
                    .and_then(OutputObserver::finish).and_then(|original| self.slot.observe_original(original));
                if result.is_err() {
                    self.slot.fail();
                    Poll::Ready(Some(Err(invalid())))
                } else { Poll::Ready(None) }
            }
        }
    }
}

impl Drop for OriginalStream {
    fn drop(&mut self) { if !self.ended { self.slot.fail(); } }
}

fn invalid() -> io::Error { io::Error::other("catpaw_output_unconfirmed") }
