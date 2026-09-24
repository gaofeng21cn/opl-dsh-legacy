/**
 * Hand-written controls for the plugin configuration forms. Each renders one
 * field's label, its staged text, whether saving would leave an override, and
 * — when one stands — the reset that stages a clear back to the composition
 * layer. Nothing here writes: a control reports what the user typed, and the
 * card's save is the single point where a draft becomes a document mutation.
 */

import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './fields.module.css'

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/**
 * One field's head: its label and, when saving would leave a user-layer entry,
 * the overridden badge with the reset that stages a clear.
 * @param props - the field's copy, its override state, and the reset action.
 * @returns the field head row shared by every control.
 */
function FieldHead(props: Pick<
  FieldProps,
  'id' | 'label' | 'overridden' | 'overriddenLabel' | 'resetLabel' | 'disabled' | 'onReset'
>) {
  return (
    <div className={css.head}>
      <label className={css.label} htmlFor={props.id}>{props.label}</label>
      {props.overridden
        ? (
          <span className={css.badges}>
            <Tag tone="neutral">{props.overriddenLabel}</Tag>
            <button
              type="button"
              className={css.reset}
              disabled={props.disabled}
              onClick={props.onReset}
            >
              {props.resetLabel}
            </button>
          </span>
        )
        : null}
    </div>
  )
}

/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps & {
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * A staged fixed-choice field. The control offers exactly the values the field's
 * spec accepts, so choosing one can never stage a draft the save would refuse;
 * the label and hint stay the card's copy.
 * @param props - the field's copy, its staged value, and the edit actions.
 * @param props.options - the choices, in display order.
 * @returns the labelled control.
 */
export function ChoiceField(props: FieldProps & {
  /** The offered choices, as stored values with their displayed labels. */
  options: ReadonlyArray<{ value: string; label: string }>
}) {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <select
        id={props.id}
        className={css.input}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        {props.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

/**
 * A note that a card's values take effect only on the next load. It is prose
 * rather than a control: the choice is stored immediately and the user decides
 * when to reload, so nothing here writes or restarts anything.
 * @param props - the note's copy.
 * @returns the notice line.
 */
export function RestartNotice(props: { text: string }) {
  return <p className={css.restart}>{props.text}</p>
}

/**
 * A write-only credential control. The value never rides a response, so the
 * control reports only whether one is configured and starts blank; a blank
 * draft writes nothing, which keeps the stored key rather than clearing it.
 * @param props - the field's copy, its staged text, and the configured state.
 * @returns the labelled control.
 */
export function SecretField(props: Pick<FieldProps, 'id' | 'label' | 'hint' | 'text' | 'disabled' | 'onEdit'> & {
  /** Whether the Host reports a configured credential for this reference. */
  configured: boolean
  /** Copy describing the configured state. */
  stateLabel: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        <span className={css.badges}>
          <Tag tone={props.configured ? 'neutral' : 'quiet'}>{props.stateLabel}</Tag>
        </span>
      </div>
      <input
        id={props.id}
        className={css.input}
        type="password"
        autoComplete="off"
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
