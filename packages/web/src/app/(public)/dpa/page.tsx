import type { Metadata } from 'next';
import { ProseHeader, ProseWrap } from '@/components/public/Prose';

export const metadata: Metadata = {
  title: 'Data Processing Addendum — Vaubaan',
  description: 'GDPR Data Processing Addendum for customers of Vaubaan.',
};

const UPDATED = '2026-05-26';

export default function DpaPage() {
  return (
    <ProseWrap>
      <ProseHeader
        eyebrow="Legal"
        title="Data Processing Addendum"
        lead="Vaubaan acts as a processor for customer data routed through the gateway."
        updated={UPDATED}
      />

      <h2>1. Subject matter</h2>
      <p>
        This Addendum forms part of the Vaubaan Terms of Service and applies whenever Vaubaan
        processes personal data on behalf of the Customer in the course of providing the Service. It
        is intended to comply with Article 28 GDPR.
      </p>

      <h2>2. Definitions</h2>
      <p>
        &ldquo;Customer Personal Data&rdquo;, &ldquo;Controller&rdquo;, &ldquo;Processor&rdquo;,
        &ldquo;Sub-processor&rdquo; and other capitalized terms have the meaning given in the GDPR.
      </p>

      <h2>3. Scope and nature of processing</h2>
      <ul>
        <li>
          <strong>Subject matter:</strong> operation of the Vaubaan MCP gateway service.
        </li>
        <li>
          <strong>Duration:</strong> for the term of the Terms of Service.
        </li>
        <li>
          <strong>Purpose:</strong> authenticate users, route MCP tool calls, enforce policy, and
          maintain the audit log.
        </li>
        <li>
          <strong>Data subjects:</strong> Customer employees, contractors, and end-users of Customer
          systems whose data passes through the gateway as part of the customer&rsquo;s workflows.
        </li>
        <li>
          <strong>Categories of data:</strong> identifiers, organizational metadata, repository /
          resource identifiers, audit metadata.
        </li>
      </ul>

      <h2>4. Customer instructions</h2>
      <p>
        Vaubaan processes Customer Personal Data only on documented instructions from the Customer,
        including for international transfers, except where required to do so by Union or Member
        State law.
      </p>

      <h2>5. Confidentiality</h2>
      <p>
        Vaubaan ensures that persons authorized to process Customer Personal Data are bound by
        appropriate confidentiality obligations.
      </p>

      <h2>6. Security</h2>
      <p>
        Vaubaan implements appropriate technical and organisational measures to ensure a level of
        security appropriate to the risk, including those described on{' '}
        <a href="/security">/security</a>.
      </p>

      <h2>7. Sub-processors</h2>
      <p>
        Vaubaan uses the sub-processors listed at <a href="/subprocessors">/subprocessors</a>. The
        Customer authorizes Vaubaan to engage these sub-processors and any successor; Vaubaan will
        give at least 14 days&rsquo; notice of new sub-processors via the same page and accept
        reasonable, documented objection.
      </p>

      <h2>8. Data subject requests</h2>
      <p>
        Vaubaan will assist the Customer with appropriate technical and organisational measures, in
        so far as possible, to respond to data subject requests.
      </p>

      <h2>9. Personal data breaches</h2>
      <p>
        Vaubaan will notify the Customer without undue delay after becoming aware of a personal data
        breach. See <a href="/security#incident">security · incident response</a>.
      </p>

      <h2>10. Return or deletion</h2>
      <p>
        At Customer request or on termination, Vaubaan will delete or return Customer Personal Data
        within 30 days, except where retention is required by law.
      </p>

      <h2>11. International transfers</h2>
      <p>
        Vaubaan is based in the European Union. Where personal data is transferred outside the EEA,
        Vaubaan relies on Standard Contractual Clauses or other valid GDPR transfer mechanisms.
      </p>

      <h2>12. Signing</h2>
      <p>
        To execute a counter-signed copy of this DPA, email{' '}
        <a href="mailto:legal@vaubaan.com">legal@vaubaan.com</a> from your billing contact.
      </p>
    </ProseWrap>
  );
}
