import Scenario from './Scenario'
import Bugsnag from '@bugsnag/react-native'

export class AppConfigAppTypeScenario extends Scenario {
  constructor (configuration, jsConfig) {
    super()
    configuration.appType = 'mobileclient'
  }

  run () {
    Bugsnag.notify(new Error('AppConfigAppTypeScenario'))
  }
}
