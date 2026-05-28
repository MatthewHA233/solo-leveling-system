import ActivityIndicator from 'react-native-web/dist/exports/ActivityIndicator'
import AppState from 'react-native-web/dist/exports/AppState'
import FlatList from 'react-native-web/dist/exports/FlatList'
import Image from 'react-native-web/dist/exports/Image'
import Keyboard from 'react-native-web/dist/exports/Keyboard'
import Modal from 'react-native-web/dist/exports/Modal'
import PanResponder from 'react-native-web/dist/exports/PanResponder'
import Pressable from 'react-native-web/dist/exports/Pressable'
import RefreshControl from 'react-native-web/dist/exports/RefreshControl'
import ScrollView from 'react-native-web/dist/exports/ScrollView'
import StyleSheet from 'react-native-web/dist/exports/StyleSheet'
import Text from 'react-native-web/dist/exports/Text'
import TextInput from 'react-native-web/dist/exports/TextInput'
import View from 'react-native-web/dist/exports/View'
import useWindowDimensions from 'react-native-web/dist/exports/useWindowDimensions'

class MirrorAnimatedValue {
  private value: number

  constructor(value: number) {
    this.value = value
  }

  setValue(value: number) {
    this.value = value
  }

  interpolate(config: { inputRange: number[]; outputRange: Array<number | string> }) {
    const [in0, in1] = config.inputRange
    const [out0, out1] = config.outputRange
    if (typeof out0 !== 'number' || typeof out1 !== 'number') return out0
    const denom = in1 - in0 || 1
    const t = Math.max(0, Math.min(1, (this.value - in0) / denom))
    return out0 + (out1 - out0) * t
  }
}

export const Animated = {
  Value: MirrorAnimatedValue,
  View,
  Text,
  ScrollView,
  timing(value: MirrorAnimatedValue, config: { toValue: number }) {
    return {
      start: (cb?: (result: { finished: boolean }) => void) => {
        value.setValue(config.toValue)
        cb?.({ finished: true })
      },
      stop: () => {},
    }
  },
}

export const DeviceEventEmitter = {
  addListener: () => ({ remove: () => {} }),
  emit: () => {},
  removeAllListeners: () => {},
}

export const NativeModules = {}

export const Platform = {
  OS: 'web',
  select: <T,>(spec: Record<string, T>): T | undefined =>
    spec.web ?? spec.default ?? spec.native,
}

export {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
}

export default {
  ActivityIndicator,
  Animated,
  AppState,
  DeviceEventEmitter,
  FlatList,
  Image,
  Keyboard,
  Modal,
  NativeModules,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
}
