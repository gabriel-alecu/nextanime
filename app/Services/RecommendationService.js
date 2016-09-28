'use strict';

const _ = require('lodash');
const pcorr = require( 'compute-pcorr' );

const Database = use('Database');
const Anime = use('App/Model/Anime');
const User = use('App/Model/User');

class RecommendationService {
  static get WATCHED_STATUS_LIST() {
    return ['watching', 'completed', 'on_hold'];
  }

  static get MIN_COMMON_SERIES() {
    return 3;
  }
  static get MIN_PEARSON_SIMILARITY() {
    return 0.5;
  }
  static get MAX_NUM_SIMILAR_USERS() {
    return 10;
  }
  static get MAX_NUM_RECCOMENDATIONS() {
    return 10;
  }

  getUsersCommonAnimeCount(userId) {
    return Database.select('ua2.user_id as other_user_id').count('ua1.anime_id as common_anime_nr')
      .from('users_anime as ua1')
      .innerJoin('users_anime as ua2', function() {
        this.on('ua1.anime_id', '=', 'ua2.anime_id')
          .andOn(Database.raw('ua1.status in (?)', [RecommendationService.WATCHED_STATUS_LIST]))
          .andOn(Database.raw('ua2.status in (?)', [RecommendationService.WATCHED_STATUS_LIST]))
          .andOn('ua2.user_id', '!=', 'ua1.user_id')
          .andOn('ua1.user_id', '=', userId)
      })
      .having('common_anime_nr', '>=', RecommendationService.MIN_COMMON_SERIES);
  }

  getUserCommonAnime(userId, otherId) {
    return Database.select('ua1.anime_id as anime_id', 'ua1.rating as user_rating', 'ua2.rating as other_user_rating')
      .from('users_anime as ua1')
      .innerJoin('users_anime as ua2', function() {
        this.on('ua1.anime_id', '=', 'ua2.anime_id')
          .andOn(Database.raw('ua1.status in (?)', [RecommendationService.WATCHED_STATUS_LIST]))
          .andOn(Database.raw('ua2.status in (?)', [RecommendationService.WATCHED_STATUS_LIST]))
          .andOn('ua2.user_id', '=', otherId)
          .andOn('ua1.user_id', '=', userId)
      });
  }

  *updateCompatibility(user) {
    const similarUserList = yield user.similar().fetch();
    for(const similarUser of similarUserList) {
      yield user.similar().detach([similarUser.id]);
      yield similarUser.similar().detach([user.id]);
      yield similarUser.update();
    }

    const userCommonAnimeList = yield this.getUsersCommonAnimeCount(user.id);

    console.log('common anime count list', userCommonAnimeList);

    for(const userCommonAnime of userCommonAnimeList) {
      const otherUserId = userCommonAnime.other_user_id;
      const commonAnimeNr = userCommonAnime.common_anime_nr;

      const commonAnimeList = yield this.getUserCommonAnime(user.id, otherUserId);
      const commonRatedAnimeList = _.filter(commonAnimeList, (commonAnime) => !_.isNil(commonAnime.user_rating) && !_.isNil(commonAnime.other_user_rating));
      const userRatingList = _.map(commonRatedAnimeList, 'user_rating');
      const otherUserRatingList = _.map(commonRatedAnimeList, 'other_user_rating');

      console.log('user common', otherUserId, commonAnimeList);
      console.log('user rating', userRatingList);
      console.log('other rating', otherUserRatingList);

      console.log('pearson', pcorr(userRatingList, otherUserRatingList));

      //the pearson module returns a matrix with the result for each combination. we only care about first x second, so we can use [0][1] or [1][0]
      const pearsonSimilarity = pcorr(userRatingList, otherUserRatingList)[0][1];

      console.log('user similarity', otherUserId, {common_series_nr: commonAnimeNr, rating_similarity: pearsonSimilarity});

      if(pearsonSimilarity >= RecommendationService.MIN_PEARSON_SIMILARITY) {
        const otherUser = yield User.findOrFail(otherUserId);
        yield user.similar().attach({[otherUser.id]: {common_series_nr: commonAnimeNr, rating_similarity: pearsonSimilarity}});
        yield otherUser.similar().attach({[user.id]: {common_series_nr: commonAnimeNr, rating_similarity: pearsonSimilarity}});
        yield otherUser.update();
      }
    }

    yield user.update();
  }

  getReccomendedAnime(userId) {
    const ratingLimitsQuery = Database.select('user_id').min('rating as min_rating').max('rating as max_rating')
      .from('users_anime')
      .groupBy('user_id')
      .as('rating_limits');

    const userAnimeQuery = Database.select('anime_id')
      .from('users_anime')
      .where('user_id', userId);

    const similarUsersQuery = Database.select('other_user_id')
      .from('users_similar')
      .where('this_user_id', userId)
      .orderBy('common_series_nr', 'desc')
      .orderBy('rating_similarity', 'desc')
      .limit(RecommendationService.MAX_NUM_SIMILAR_USERS)
      .as('similar_users');

    return Database.select('users_anime.anime_id', Database.raw('avg(1.0*users_anime.rating/(rating_limits.max_rating - rating_limits.min_rating)) as avg_rating')).count('users_anime.anime_id as nr_appearances')
      .from('users_anime')
      .innerJoin(ratingLimitsQuery, 'users_anime.user_id', 'rating_limits.user_id')
      .innerJoin(similarUsersQuery, 'users_anime.user_id', 'similar_users.other_user_id')
      .whereNotIn('users_anime.anime_id', userAnimeQuery)
      .andWhere('users_anime.status', 'in', RecommendationService.WATCHED_STATUS_LIST)
      .groupBy('users_anime.anime_id')
      .orderBy('nr_appearances', 'desc')
      .orderBy('avg_rating', 'desc')
      .limit(RecommendationService.MAX_NUM_RECCOMENDATIONS);
  }

  *getRecommendations(user) {
    const reccomendedAnimeList = yield this.getReccomendedAnime(user.id);
    console.log(reccomendedAnimeList);
    const reccomendedAnimeIdList = _.map(reccomendedAnimeList, 'anime_id');
    const reccomendedAnime = yield Anime.query().whereIn('id', reccomendedAnimeIdList).fetch();

    //database doesn't care about given id order, so we need to re-order them
    const reccomendedAnimeListKeyed = _.keyBy(reccomendedAnimeList, 'anime_id');
    return reccomendedAnime
      .orderBy((anime) => reccomendedAnimeListKeyed[anime.id].nr_appearances, 'desc')
      .orderBy((anime) => reccomendedAnimeListKeyed[anime.id].avg_rating, 'desc');
  }
}

module.exports = RecommendationService;
