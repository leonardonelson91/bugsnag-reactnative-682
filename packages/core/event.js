const ErrorStackParser = require('./lib/error-stack-parser')
const StackGenerator = require('stack-generator')
const hasStack = require('./lib/has-stack')
const { reduce, filter } = require('./lib/es-utils')
const jsRuntime = require('./lib/js-runtime')
const metadataDelegate = require('./lib/metadata-delegate')
const isError = require('./lib/iserror')

class BugsnagEvent {
  constructor (errorClass, errorMessage, stacktrace = [], handledState = defaultHandledState(), originalError) {
    // duck-typing ftw >_<
    this.__isBugsnagEvent = true

    // private (un)handled state
    this._handledState = handledState

    // setable props
    this.app = undefined
    this.apiKey = undefined
    this.breadcrumbs = []
    this.context = undefined
    this.device = undefined
    this.errorClass = stringOrFallback(errorClass, '[no error class]')
    this.errorMessage = stringOrFallback(errorMessage, '[no error message]')
    this.groupingHash = undefined
    this._metadata = {}
    this.request = undefined
    this.severity = this._handledState.severity
    this.stacktrace = reduce(stacktrace, (accum, frame) => {
      const f = formatStackframe(frame)
      // don't include a stackframe if none of its properties are defined
      try {
        if (JSON.stringify(f) === '{}') return accum
        return accum.concat(f)
      } catch (e) {
        return accum
      }
    }, [])
    this._user = {}
    this.session = undefined
    this.originalError = originalError

    // Flags.
    // Note these are not initialised unless they are used
    // to save unnecessary bytes in the browser bundle

    /* this.attemptImmediateDelivery, default: true */
  }

  addMetadata (section, ...args) {
    return metadataDelegate.add(this._metadata, section, ...args)
  }

  getMetadata (section, key) {
    return metadataDelegate.get(this._metadata, section, key)
  }

  clearMetadata (section, key) {
    return metadataDelegate.clear(this._metadata, section, key)
  }

  getUser () {
    return this._user
  }

  setUser (id, email, name) {
    this._user = { id, email, name }
  }

  toJSON () {
    return {
      payloadVersion: '4',
      exceptions: [
        {
          errorClass: this.errorClass,
          message: this.errorMessage,
          stacktrace: this.stacktrace,
          type: jsRuntime
        }
      ],
      severity: this.severity,
      unhandled: this._handledState.unhandled,
      severityReason: this._handledState.severityReason,
      app: this.app,
      device: this.device,
      breadcrumbs: this.breadcrumbs,
      context: this.context,
      metaData: this._metadata,
      user: this._user,
      groupingHash: this.groupingHash,
      request: this.request,
      session: this.session
    }
  }
}

// takes a stacktrace.js style stackframe (https://github.com/stacktracejs/stackframe)
// and returns a Bugsnag compatible stackframe (https://docs.bugsnag.com/api/error-reporting/#json-payload)
const formatStackframe = frame => {
  const f = {
    file: frame.fileName,
    method: normaliseFunctionName(frame.functionName),
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
    code: undefined,
    inProject: undefined
  }
  // Some instances result in no file:
  // - calling notify() from chrome's terminal results in no file/method.
  // - non-error exception thrown from global code in FF
  // This adds one.
  if (f.lineNumber > -1 && !f.file && !f.method) {
    f.file = 'global code'
  }
  return f
}

const normaliseFunctionName = name => /^global code$/i.test(name) ? 'global code' : name

const defaultHandledState = () => ({
  unhandled: false,
  severity: 'warning',
  severityReason: { type: 'handledException' }
})

const stringOrFallback = (str, fallback) => typeof str === 'string' && str ? str : fallback

// Helpers

BugsnagEvent.getStacktrace = function (error, errorFramesToSkip, backtraceFramesToSkip) {
  if (hasStack(error)) return ErrorStackParser.parse(error).slice(errorFramesToSkip)
  // error wasn't provided or didn't have a stacktrace so try to walk the callstack
  try {
    return filter(StackGenerator.backtrace(), frame =>
      (frame.functionName || '').indexOf('StackGenerator$$') === -1
    ).slice(1 + backtraceFramesToSkip)
  } catch (e) {
    return []
  }
}

BugsnagEvent.create = function (maybeError, tolerateNonErrors, handledState, component, errorFramesToSkip = 0, logger) {
  const [error, internalFrames] = normaliseError(maybeError, tolerateNonErrors, component, logger)
  let event
  try {
    const stacktrace = BugsnagEvent.getStacktrace(
      error,
      // if an error was created/throw in the normaliseError() function, we need to
      // tell the getStacktrace() function to skip the number of frames we know will
      // be from our own functions. This is added to the number of frames deep we
      // were told about
      internalFrames > 0 ? 1 + internalFrames + errorFramesToSkip : 0,
      // if there's no stacktrace, the callstack may be walked to generated one.
      // this is how many frames should be removed because they come from our library
      1 + errorFramesToSkip
    )
    event = new BugsnagEvent(error.name, error.message, stacktrace, handledState, maybeError)
  } catch (e) {
    event = new BugsnagEvent(error.name, error.message, [], handledState, maybeError)
  }
  if (error.name === 'InvalidError') {
    event.addMetadata(`${component}`, 'non-error parameter', makeSerialisable(maybeError))
  }
  return event
}

const makeSerialisable = (err) => {
  if (err === null) {
    return 'null'
  } else if (err === undefined) {
    return 'undefined'
  } else if (isError(err)) {
    return {
      [Object.prototype.toString.call(err)]: {
        name: err.name,
        message: err.message,
        code: err.code,
        stack: err.stack
      }
    }
  } else {
    return err
  }
}

const normaliseError = (maybeError, tolerateNonErrors, component, logger) => {
  let error
  let internalFrames = 0

  const createAndLogInputError = (reason, value) => {
    if (logger) logger.warn(`${component} received a non-error: "${reason}"`)
    const err = new Error(`${component} received a non-error. See "${component}" tab for more detail.`)
    err.name = 'InvalidError'
    return err
  }

  if (!tolerateNonErrors) {
    if (isError(maybeError)) {
      error = maybeError
    } else {
      error = createAndLogInputError(typeof maybeError, maybeError)
      internalFrames += 2
    }
  } else {
    switch (typeof maybeError) {
      case 'string':
      case 'number':
      case 'boolean':
        error = new Error(String(maybeError))
        internalFrames += 1
        break
      case 'function':
        error = createAndLogInputError('function', maybeError)
        internalFrames += 2
        break
      case 'object':
        if (maybeError !== null && isError(maybeError)) {
          error = maybeError
        } else if (maybeError !== null && hasNecessaryFields(maybeError)) {
          error = new Error(maybeError.message || maybeError.errorMessage)
          error.name = maybeError.name || maybeError.errorClass
          internalFrames += 1
        } else {
          error = createAndLogInputError(maybeError === null ? 'null' : 'unsupported object', maybeError)
          internalFrames += 2
        }
        break
      default:
        error = createAndLogInputError('nothing', maybeError)
        internalFrames++
    }
  }

  if (!hasStack(error)) {
    // in IE10/11 a new Error() doesn't have a stacktrace until you throw it, so try that here
    try {
      throw error
    } catch (e) {
      if (hasStack(e)) {
        error = e
        // if the error only got a stacktrace after we threw it here, we know it
        // will only have one extra internal frame from this function, regardless
        // of whether it went through createAndLogInputError() or not
        internalFrames = 1
      }
    }
  }

  return [error, internalFrames]
}

const hasNecessaryFields = error =>
  (typeof error.name === 'string' || typeof error.errorClass === 'string') &&
  (typeof error.message === 'string' || typeof error.errorMessage === 'string')

module.exports = BugsnagEvent
