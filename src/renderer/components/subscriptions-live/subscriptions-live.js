import { defineComponent } from 'vue'
import { mapActions, mapMutations } from 'vuex'
import SubscriptionsTabUI from '../subscriptions-tab-ui/subscriptions-tab-ui.vue'

import { copyToClipboard, showToast } from '../../helpers/utils'
import { invidiousAPICall } from '../../helpers/api/invidious'
import { getLocalChannelLiveStreams } from '../../helpers/api/local'
import { addPublishedDatesInvidious, addPublishedDatesLocal, parseYouTubeRSSFeed, updateVideoListAfterProcessing } from '../../helpers/subscriptions'

export default defineComponent({
  name: 'SubscriptionsLive',
  components: {
    'subscriptions-tab-ui': SubscriptionsTabUI
  },
  data: function () {
    return {
      isLoading: false,
      videoList: [],
      errorChannels: [],
      attemptedFetch: false,
    }
  },
  computed: {
    backendPreference: function () {
      return this.$store.getters.getBackendPreference
    },

    backendFallback: function () {
      return this.$store.getters.getBackendFallback
    },

    currentInvidiousInstance: function () {
      return this.$store.getters.getCurrentInvidiousInstance
    },

    useRssFeeds: function () {
      return this.$store.getters.getUseRssFeeds
    },

    activeProfile: function () {
      return this.$store.getters.getActiveProfile
    },
    activeProfileId: function () {
      return this.activeProfile._id
    },

    cacheEntriesForAllActiveProfileChannels() {
      const entries = []
      this.activeSubscriptionList.forEach((channel) => {
        const cacheEntry = this.$store.getters.getLiveCacheByChannel(channel.id)
        if (cacheEntry == null) { return }

        entries.push(cacheEntry)
      })
      return entries
    },
    videoCacheForAllActiveProfileChannelsPresent() {
      if (this.cacheEntriesForAllActiveProfileChannels.length === 0) { return false }
      if (this.cacheEntriesForAllActiveProfileChannels.length < this.activeSubscriptionList.length) { return false }

      return this.cacheEntriesForAllActiveProfileChannels.every((cacheEntry) => {
        return cacheEntry.videos != null
      })
    },

    activeSubscriptionList: function () {
      return this.activeProfile.subscriptions
    },

    fetchSubscriptionsAutomatically: function() {
      return this.$store.getters.getFetchSubscriptionsAutomatically
    },
  },
  watch: {
    activeProfile: async function (_) {
      this.isLoading = true
      this.loadVideosFromCacheSometimes()
    },
  },
  mounted: async function () {
    this.isLoading = true

    this.loadVideosFromCacheSometimes()
  },
  methods: {
    loadVideosFromCacheSometimes() {
      // This method is called on view visible
      if (this.videoCacheForAllActiveProfileChannelsPresent) {
        this.loadVideosFromCacheForAllActiveProfileChannels()
        return
      }

      this.maybeLoadVideosForSubscriptionsFromRemote()
    },

    async loadVideosFromCacheForAllActiveProfileChannels() {
      const videoList = []
      this.activeSubscriptionList.forEach((channel) => {
        const channelCacheEntry = this.$store.getters.getLiveCacheByChannel(channel.id)

        videoList.push(...channelCacheEntry.videos)
      })
      this.videoList = updateVideoListAfterProcessing(videoList)
      this.isLoading = false
    },

    loadVideosForSubscriptionsFromRemote: async function () {
      if (this.activeSubscriptionList.length === 0) {
        this.isLoading = false
        this.videoList = []
        return
      }

      const channelsToLoadFromRemote = this.activeSubscriptionList
      const videoList = []
      let channelCount = 0
      this.isLoading = true

      let useRss = this.useRssFeeds
      if (channelsToLoadFromRemote.length >= 125 && !useRss) {
        showToast(
          this.$t('Subscriptions["This profile has a large number of subscriptions. Forcing RSS to avoid rate limiting"]'),
          10000
        )
        useRss = true
      }
      this.updateShowProgressBar(true)
      this.setProgressBarPercentage(0)
      this.attemptedFetch = true

      this.errorChannels = []
      const videoListFromRemote = (await Promise.all(channelsToLoadFromRemote.map(async (channel) => {
        let videos = []
        if (!process.env.IS_ELECTRON || this.backendPreference === 'invidious') {
          if (useRss) {
            videos = await this.getChannelLiveInvidiousRSS(channel)
          } else {
            videos = await this.getChannelLiveInvidious(channel)
          }
        } else {
          if (useRss) {
            videos = await this.getChannelLiveLocalRSS(channel)
          } else {
            videos = await this.getChannelLiveLocal(channel)
          }
        }

        channelCount++
        const percentageComplete = (channelCount / channelsToLoadFromRemote.length) * 100
        this.setProgressBarPercentage(percentageComplete)
        this.updateSubscriptionLiveCacheByChannel({
          channelId: channel.id,
          videos: videos,
        })
        return videos
      }))).flatMap((o) => o)
      videoList.push(...videoListFromRemote)

      this.videoList = updateVideoListAfterProcessing(videoList)
      this.isLoading = false
      this.updateShowProgressBar(false)
    },

    maybeLoadVideosForSubscriptionsFromRemote: async function () {
      if (this.fetchSubscriptionsAutomatically) {
        // `this.isLoading = false` is called inside `loadVideosForSubscriptionsFromRemote` when needed
        await this.loadVideosForSubscriptionsFromRemote()
      } else {
        this.videoList = []
        this.attemptedFetch = false
        this.isLoading = false
      }
    },

    getChannelLiveLocal: async function (channel, failedAttempts = 0) {
      try {
        const entries = await getLocalChannelLiveStreams(channel.id)

        if (entries === null) {
          this.errorChannels.push(channel)
          return []
        }

        addPublishedDatesLocal(entries)

        return entries
      } catch (err) {
        console.error(err)
        const errorMessage = this.$t('Local API Error (Click to copy)')
        showToast(`${errorMessage}: ${err}`, 10000, () => {
          copyToClipboard(err)
        })
        switch (failedAttempts) {
          case 0:
            return await this.getChannelLiveLocalRSS(channel, failedAttempts + 1)
          case 1:
            if (this.backendFallback) {
              showToast(this.$t('Falling back to Invidious API'))
              return await this.getChannelLiveInvidious(channel, failedAttempts + 1)
            } else {
              return []
            }
          case 2:
            return await this.getChannelLiveLocalRSS(channel, failedAttempts + 1)
          default:
            return []
        }
      }
    },

    getChannelLiveLocalRSS: async function (channel, failedAttempts = 0) {
      const playlistId = channel.id.replace('UC', 'UULV')
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`

      try {
        const response = await fetch(feedUrl)

        if (response.status === 404) {
          // playlists don't exist if the channel was terminated but also if it doesn't have the tab,
          // so we need to check the channel feed too before deciding it errored, as that only 404s if the channel was terminated

          const response2 = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`, {
            method: 'HEAD'
          })

          if (response2.status === 404) {
            this.errorChannels.push(channel)
          }

          return []
        }

        return await parseYouTubeRSSFeed(await response.text(), channel.id)
      } catch (error) {
        console.error(error)
        const errorMessage = this.$t('Local API Error (Click to copy)')
        showToast(`${errorMessage}: ${error}`, 10000, () => {
          copyToClipboard(error)
        })
        switch (failedAttempts) {
          case 0:
            return this.getChannelLiveLocal(channel, failedAttempts + 1)
          case 1:
            if (this.backendFallback) {
              showToast(this.$t('Falling back to Invidious API'))
              return this.getChannelLiveInvidiousRSS(channel, failedAttempts + 1)
            } else {
              return []
            }
          case 2:
            return this.getChannelLiveLocal(channel, failedAttempts + 1)
          default:
            return []
        }
      }
    },

    getChannelLiveInvidious: function (channel, failedAttempts = 0) {
      return new Promise((resolve, reject) => {
        const subscriptionsPayload = {
          resource: 'channels',
          id: channel.id,
          subResource: 'streams',
          params: {}
        }

        invidiousAPICall(subscriptionsPayload).then((result) => {
          const videos = result.videos.filter(e => e.type === 'video')

          addPublishedDatesInvidious(videos)

          resolve(videos)
        }).catch((err) => {
          console.error(err)
          const errorMessage = this.$t('Invidious API Error (Click to copy)')
          showToast(`${errorMessage}: ${err.responseText}`, 10000, () => {
            copyToClipboard(err.responseText)
          })
          switch (failedAttempts) {
            case 0:
              resolve(this.getChannelLiveInvidiousRSS(channel, failedAttempts + 1))
              break
            case 1:
              if (process.env.IS_ELECTRON && this.backendFallback) {
                showToast(this.$t('Falling back to the local API'))
                resolve(this.getChannelLiveLocal(channel, failedAttempts + 1))
              } else {
                resolve([])
              }
              break
            case 2:
              resolve(this.getChannelLiveInvidiousRSS(channel, failedAttempts + 1))
              break
            default:
              resolve([])
          }
        })
      })
    },

    getChannelLiveInvidiousRSS: async function (channel, failedAttempts = 0) {
      const playlistId = channel.id.replace('UC', 'UULV')
      const feedUrl = `${this.currentInvidiousInstance}/feed/playlist/${playlistId}`

      try {
        const response = await fetch(feedUrl)

        if (response.status === 500 || response.status === 404) {
          return []
        }

        return await parseYouTubeRSSFeed(await response.text(), channel.id)
      } catch (error) {
        console.error(error)
        const errorMessage = this.$t('Invidious API Error (Click to copy)')
        showToast(`${errorMessage}: ${error}`, 10000, () => {
          copyToClipboard(error)
        })
        switch (failedAttempts) {
          case 0:
            return this.getChannelLiveInvidious(channel, failedAttempts + 1)
          case 1:
            if (process.env.IS_ELECTRON && this.backendFallback) {
              showToast(this.$t('Falling back to the local API'))
              return this.getChannelLiveLocalRSS(channel, failedAttempts + 1)
            } else {
              return []
            }
          case 2:
            return this.getChannelLiveInvidious(channel, failedAttempts + 1)
          default:
            return []
        }
      }
    },

    ...mapActions([
      'updateShowProgressBar',
      'updateSubscriptionLiveCacheByChannel',
    ]),

    ...mapMutations([
      'setProgressBarPercentage'
    ])
  }
})
