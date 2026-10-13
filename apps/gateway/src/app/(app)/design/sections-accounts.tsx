'use client';

/**
 * Gallery, the components added with the accounts, activity and settings
 * pages: the grid of choices (the services an account can be connected to)
 * and the button whose form post is asked first.
 */
import { ConfirmSubmit, PickCard, PickGrid, ServiceMark } from '@/components/ui';

import { GallerySection, Line, Specimen } from './specimen';

export function AccountSections() {
  return (
    <>
      <GallerySection
        id="pick"
        title="Choice cards"
        rule="A handful of choices of the same kind, each leading somewhere: a mark, a name, one line that says how. The exception to “rows, not cards”: the cards are the action. One that cannot be taken yet is dashed and says why."
      >
        <Specimen name="Services to connect" note="one cannot be taken yet">
          {() => (
            <PickGrid label="Services">
              <PickCard
                href="#pick"
                lead={<ServiceMark name="GitHub" />}
                title="GitHub"
                description="install your company’s GitHub app"
              />
              <PickCard
                href="#pick"
                lead={<ServiceMark name="Stripe" />}
                title="Stripe"
                description="paste: test-mode key and live-mode key"
              />
              <PickCard
                unavailable
                lead={<ServiceMark name="Railway" />}
                title="Railway"
                description="needs a company app · ask an administrator"
              />
            </PickGrid>
          )}
        </Specimen>
      </GallerySection>

      <GallerySection
        id="confirm-submit"
        title="Asked first"
        rule="An act that stops, removes or hands over something is a button that opens a dialog stating the consequence; confirming posts a plain form. An act that only adds or edits is a plain submit button."
      >
        <Specimen name="Remove, deactivate, disconnect" note="the dialog opens on a press">
          {() => (
            <Line>
              <ConfirmSubmit
                action="#confirm-submit"
                label="Remove"
                ariaLabel="Remove the access of Carol"
                variant="danger"
                tone="danger"
                title="Remove the access of Carol?"
                consequence="Carol can no longer write missions on this account, and the 2 missions that use it stop at once: every call is refused, with the reason."
                confirmLabel="Remove access"
                hint="Recorded in the activity, like every change."
              />
              <ConfirmSubmit
                action="#confirm-submit"
                label="Disconnect"
                ariaLabel="Disconnect Claude Code"
                title="Disconnect Claude Code?"
                consequence="The app loses its access at once. The missions it prepared are yours and keep running."
                confirmLabel="Disconnect"
              />
            </Line>
          )}
        </Specimen>
      </GallerySection>
    </>
  );
}
