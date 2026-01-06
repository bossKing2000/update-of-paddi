// lib/features/products/notifiers/product_notifier.dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../data/models/model_response.dart';
import '../data/models/productsModel.dart';
import '../data/repositories/productRepo.dart';
import '../data/sources/productApiservice.dart';

// Providers
final productApiServiceProvider = Provider<ProductApiService>((ref) {
  return ProductApiService(ref);
});

final productRepositoryProvider = Provider<ProductRepository>((ref) {
  final apiService = ref.watch(productApiServiceProvider);
  return ProductRepository(apiService);
});

// Schedule operation state provider - ADD THIS
final scheduleOperationStateProvider =
    StateProvider<AsyncValue<ScheduleResponse?>>(
      (_) => const AsyncValue.data(null),
    );

final productNotifierProvider =
    StateNotifierProvider<ProductNotifier, AsyncValue<List<Product>>>((ref) {
      final repo = ref.watch(productRepositoryProvider);
      return ProductNotifier(repo, ref); // Pass ref here
    });

class ProductNotifier extends StateNotifier<AsyncValue<List<Product>>> {
  final ProductRepository repository;
  final Ref ref; // ADD THIS FIELD

  ProductNotifier(this.repository, this.ref)
    : super(const AsyncValue.loading()); // Add ref parameter

  // ============ EXISTING PRODUCT METHODS ============

  Future<void> fetchAll({
    int page = 1,
    int limit = 20,
    String? category,
  }) async {
    try {
      state = const AsyncValue.loading();
      final products = await repository.fetchAll(
        page: page,
        limit: limit,
        category: category,
      );
      state = AsyncValue.data(products);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<Product> fetchById(String id) => repository.fetchById(id);

  Future<void> fetchMostPopular({int page = 1, int limit = 20}) async {
    try {
      state = const AsyncValue.loading();
      final products = await repository.fetchMostPopular(
        page: page,
        limit: limit,
      );
      state = AsyncValue.data(products);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  Future<void> search(String query, {int page = 1, int limit = 20}) async {
    try {
      state = const AsyncValue.loading();
      final products = await repository.search(query, page: page, limit: limit);
      state = AsyncValue.data(products);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  // ============ NEW SCHEDULE METHODS ============

  Future<ScheduleResponse?> scheduleGoLive({
    required String productId,
    required DateTime goLiveAt,
    required DateTime takeDownAt,
    int graceMinutes = 0,
  }) async {
    final scheduleState = ref.read(scheduleOperationStateProvider.notifier);

    try {
      scheduleState.state = const AsyncValue.loading();

      final response = await repository.scheduleGoLive(
        productId: productId,
        goLiveAt: goLiveAt,
        takeDownAt: takeDownAt,
        graceMinutes: graceMinutes,
      );

      scheduleState.state = AsyncValue.data(response);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      state = AsyncValue.error(e, st); // Update main state too
      return null;
    }
  }

  Future<ScheduleResponse?> takeDownProduct({
    required String productId,
    required DateTime takeDownAt,
  }) async {
    final scheduleState = ref.read(scheduleOperationStateProvider.notifier);

    try {
      scheduleState.state = const AsyncValue.loading();

      final response = await repository.takeDownProduct(
        productId: productId,
        takeDownAt: takeDownAt,
      );

      scheduleState.state = AsyncValue.data(response);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      return null;
    }
  }

  Future<ScheduleResponse?> extendGracePeriod({
    required String productId,
    required int additionalMinutes,
  }) async {
    final scheduleState = ref.read(scheduleOperationStateProvider.notifier);

    try {
      scheduleState.state = const AsyncValue.loading();

      final response = await repository.extendGracePeriod(
        productId: productId,
        additionalMinutes: additionalMinutes,
      );

      scheduleState.state = AsyncValue.data(response);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      return null;
    }
  }

  Future<ScheduleResponse?> fixLiveStatuses() async {
    final scheduleState = ref.read(scheduleOperationStateProvider.notifier);

    try {
      scheduleState.state = const AsyncValue.loading();

      final response = await repository.fixLiveStatuses();

      scheduleState.state = AsyncValue.data(response);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      return null;
    }
  }
}