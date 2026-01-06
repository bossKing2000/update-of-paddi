// lib/features/products/notifiers/product_notifier.dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../data/models/model_response.dart';
import '../data/models/productsModel.dart';
import '../data/repositories/productRepo.dart';
import '../data/sources/productApiservice.dart';
// //
// // // Providers
// // final productApiServiceProvider = Provider<ProductApiService>((ref) {
// //   return ProductApiService(ref);
// // });
// //
// // final productRepositoryProvider = Provider<ProductRepository>((ref) {
// //   final apiService = ref.watch(productApiServiceProvider);
// //   return ProductRepository(apiService);
// // });
// //
// // // Schedule operation state provider - ADD THIS
// // final scheduleOperationStateProvider =
// //     StateProvider<AsyncValue<ScheduleResponse?>>(
// //       (_) => const AsyncValue.data(null),
// //     );
// //
// // final productNotifierProvider =
// //     StateNotifierProvider<ProductNotifier, AsyncValue<List<Product>>>((ref) {
// //       final repo = ref.watch(productRepositoryProvider);
// //       return ProductNotifier(repo, ref); // Pass ref here
// //     });
// //
// // class ProductNotifier extends StateNotifier<AsyncValue<List<Product>>> {
// //   final ProductRepository repository;
// //   final Ref ref; // ADD THIS FIELD
// //
// //   ProductNotifier(this.repository, this.ref)
// //     : super(const AsyncValue.loading()); // Add ref parameter
// //
// //   // ============ EXISTING PRODUCT METHODS ============
// //
// //   Future<void> fetchAll({
// //     int page = 1,
// //     int limit = 20,
// //     String? category,
// //   }) async {
// //     try {
// //       state = const AsyncValue.loading();
// //       final products = await repository.fetchAll(
// //         page: page,
// //         limit: limit,
// //         category: category,
// //       );
// //       state = AsyncValue.data(products);
// //     } catch (e, st) {
// //       state = AsyncValue.error(e, st);
// //     }
// //   }
// //
// //   Future<Product> fetchById(String id) => repository.fetchById(id);
// //
// //   Future<void> fetchMostPopular({int page = 1, int limit = 20}) async {
// //     try {
// //       state = const AsyncValue.loading();
// //       final products = await repository.fetchMostPopular(
// //         page: page,
// //         limit: limit,
// //       );
// //       state = AsyncValue.data(products);
// //     } catch (e, st) {
// //       state = AsyncValue.error(e, st);
// //     }
// //   }
// //
// //   Future<void> search(String query, {int page = 1, int limit = 20}) async {
// //     try {
// //       state = const AsyncValue.loading();
// //       final products = await repository.search(query, page: page, limit: limit);
// //       state = AsyncValue.data(products);
// //     } catch (e, st) {
// //       state = AsyncValue.error(e, st);
// //     }
// //   }
// //
// //   // ============ NEW SCHEDULE METHODS ============
// //
// //   Future<ScheduleResponse?> scheduleGoLive({
// //     required String productId,
// //     required DateTime goLiveAt,
// //     required DateTime takeDownAt,
// //     int graceMinutes = 0,
// //   }) async {
// //     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
// //
// //     try {
// //       scheduleState.state = const AsyncValue.loading();
// //
// //       final response = await repository.scheduleGoLive(
// //         productId: productId,
// //         goLiveAt: goLiveAt,
// //         takeDownAt: takeDownAt,
// //         graceMinutes: graceMinutes,
// //       );
// //
// //       scheduleState.state = AsyncValue.data(response);
// //
// //       // ✅ Fetch fresh product data and update cache
// //       try {
// //         final freshProduct = await fetchById(productId);
// //         updateProductInList(productId, (_) => freshProduct);
// //       } catch (e) {
// //         // Silently fail - user can refresh manually
// //       }
// //
// //       _autoClearScheduleState(scheduleState, seconds: 3);
// //       return response;
// //     } catch (e, st) {
// //       scheduleState.state = AsyncValue.error(e, st);
// //       _autoClearScheduleState(scheduleState, seconds: 5);
// //       rethrow;
// //     }
// //   }
// //
// //   // Take product down (end live session)
// //   Future<ScheduleResponse?> takeProductDown(String productId) async {
// //     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
// //
// //     try {
// //       scheduleState.state = const AsyncValue.loading();
// //       final response = await repository.takeProductDown(productId);
// //       scheduleState.state = AsyncValue.data(response);
// //
// //       // Update product in list to mark as offline
// //       updateProductInList(productId, (product) {
// //         return product.copyWith(
// //           isLive: false,
// //           liveUntil: null,
// //           productSchedule: ProductSchedule(
// //             goLiveAt: null,
// //             takeDownAt: null,
// //             graceMinutes: 0,
// //             isLive: false,
// //           ),
// //         );
// //       });
// //
// //       _autoClearScheduleState(scheduleState, seconds: 3);
// //       return response;
// //     } catch (e, st) {
// //       scheduleState.state = AsyncValue.error(e, st);
// //       _autoClearScheduleState(scheduleState, seconds: 5);
// //       rethrow;
// //     }
// //   }
// //
// //   // Extend grace period for a live product
// //   Future<ScheduleResponse?> extendGracePeriod({
// //     required String productId,
// //     required int extraMinutes,
// //   }) async {
// //     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
// //
// //     try {
// //       scheduleState.state = const AsyncValue.loading();
// //       final response = await repository.extendGracePeriod(
// //         productId: productId,
// //         extraMinutes: extraMinutes,
// //       );
// //       scheduleState.state = AsyncValue.data(response);
// //
// //       // Update product's grace period in the list
// //       updateProductInList(productId, (product) {
// //         final currentSchedule = product.productSchedule;
// //         final currentGrace = currentSchedule?.graceMinutes ?? 0;
// //
// //         return product.copyWith(
// //           productSchedule:
// //               currentSchedule?.copyWith(
// //                 graceMinutes: currentGrace + extraMinutes,
// //               ) ??
// //               ProductSchedule(graceMinutes: extraMinutes),
// //         );
// //       });
// //
// //       _autoClearScheduleState(scheduleState, seconds: 3);
// //       return response;
// //     } catch (e, st) {
// //       scheduleState.state = AsyncValue.error(e, st);
// //       _autoClearScheduleState(scheduleState, seconds: 5);
// //       rethrow;
// //     }
// //   }
// //
// //   // Fix live statuses (admin/utility function)
// //   Future<ScheduleResponse?> fixLiveStatuses() async {
// //     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
// //
// //     try {
// //       scheduleState.state = const AsyncValue.loading();
// //       final response = await repository.fixLiveStatuses();
// //       scheduleState.state = AsyncValue.data(response);
// //       _autoClearScheduleState(scheduleState, seconds: 3);
// //       return response;
// //     } catch (e, st) {
// //       scheduleState.state = AsyncValue.error(e, st);
// //       _autoClearScheduleState(scheduleState, seconds: 5);
// //       rethrow;
// //     }
// //   }
// //
// //   // ============ HELPER METHODS ============
// //
// //   // Update product in list
// //   void updateProductInList(
// //     String productId,
// //     Product Function(Product) updateFn,
// //   ) {
// //     state.whenData((products) {
// //       final index = products.indexWhere((p) => p.id == productId);
// //       if (index != -1) {
// //         final product = products[index];
// //         final updatedProduct = updateFn(product);
// //         final newProducts = List<Product>.from(products);
// //         newProducts[index] = updatedProduct;
// //         state = AsyncValue.data(newProducts);
// //       }
// //     });
// //   }
// //
// //   // Add product to list
// //   void addProduct(Product product) {
// //     state.whenData((products) {
// //       final newProducts = List<Product>.from(products);
// //       newProducts.insert(0, product);
// //       state = AsyncValue.data(newProducts);
// //     });
// //   }
// //
// //   // Remove product from list
// //   void removeProduct(String productId) {
// //     state.whenData((products) {
// //       final newProducts = products.where((p) => p.id != productId).toList();
// //       state = AsyncValue.data(newProducts);
// //     });
// //   }
// //
// //   // Update product directly
// //   void updateProduct(Product updatedProduct) {
// //     updateProductInList(updatedProduct.id, (_) => updatedProduct);
// //   }
// //
// //   // Refresh a single product
// //   Future<void> refreshProduct(String productId) async {
// //     try {
// //       final refreshedProduct = await fetchById(productId);
// //       updateProduct(refreshedProduct);
// //     } catch (e) {
// //       // Silently fail
// //     }
// //   }
// //
// //   // Get product by ID
// //   Product? getProductById(String productId) {
// //     return state.maybeWhen(
// //       data: (products) {
// //         try {
// //           return products.firstWhere((p) => p.id == productId);
// //         } catch (_) {
// //           return null;
// //         }
// //       },
// //       orElse: () => null,
// //     );
// //   }
// //
// //   // Check if product exists
// //   bool hasProduct(String productId) {
// //     return state.maybeWhen(
// //       data: (products) => products.any((p) => p.id == productId),
// //       orElse: () => false,
// //     );
// //   }
// //
// //   // Clear product list
// //   void clearProductList() {
// //     state = const AsyncValue.data([]);
// //   }
// //
// //   // Auto-clear schedule state
// //   void _autoClearScheduleState(
// //     StateController<AsyncValue<ScheduleResponse?>> scheduleState, {
// //     required int seconds,
// //   }) {
// //     Future.delayed(Duration(seconds: seconds), () {
// //       scheduleState.state = const AsyncValue.data(null);
// //     });
// //   }
// //
// //   // Get schedule operation state
// //   AsyncValue<ScheduleResponse?> getScheduleOperationState() {
// //     return ref.read(scheduleOperationStateProvider);
// //   }
// //
// //   // Clear schedule operation state
// //   void clearScheduleOperationState() {
// //     ref.read(scheduleOperationStateProvider.notifier).state =
// //         const AsyncValue.data(null);
// //   }
// // }
//
// // lib/features/products/notifiers/product_notifier.dart
// import 'dart:io';
//
// import 'package:flutter_riverpod/flutter_riverpod.dart';
// import 'package:flutter_riverpod/legacy.dart';
//
// import '../data/models/create_product_model.dart';
// import '../data/models/model_response.dart';
// import '../data/models/productsModel.dart';
// import '../data/repositories/productRepo.dart';
// import '../data/sources/productApiservice.dart';
//
// // Providers
// final productApiServiceProvider = Provider<ProductApiService>((ref) {
//   return ProductApiService(ref);
// });
//
// final productRepositoryProvider = Provider<ProductRepository>((ref) {
//   final apiService = ref.watch(productApiServiceProvider);
//   return ProductRepository(apiService);
// });
//
// // Schedule operation state provider
// final scheduleOperationStateProvider =
//     StateProvider<AsyncValue<ScheduleResponse?>>(
//       (_) => const AsyncValue.data(null),
//     );
//
// // Create product state provider
// final createProductStateProvider =
//     StateProvider<AsyncValue<ApiResponse<Product>?>>(
//       (_) => const AsyncValue.data(null),
//     );
//
// // Create product loading state provider
// final createProductLoadingStateProvider = StateProvider<bool>((_) => false);
//
// final productNotifierProvider =
//     StateNotifierProvider<ProductNotifier, AsyncValue<List<Product>>>((ref) {
//       final repo = ref.watch(productRepositoryProvider);
//       return ProductNotifier(repo, ref);
//     });
//
// class ProductNotifier extends StateNotifier<AsyncValue<List<Product>>> {
//   final ProductRepository repository;
//   final Ref ref;
//
//   ProductNotifier(this.repository, this.ref)
//     : super(const AsyncValue.loading());
//
//   // ============ EXISTING PRODUCT METHODS ============
//
//   Future<void> fetchAll({
//     int page = 1,
//     int limit = 20,
//     String? category,
//   }) async {
//     try {
//       state = const AsyncValue.loading();
//       final products = await repository.fetchAll(
//         page: page,
//         limit: limit,
//         category: category,
//       );
//       state = AsyncValue.data(products);
//     } catch (e, st) {
//       state = AsyncValue.error(e, st);
//     }
//   }
//
//   Future<Product> fetchById(String id) => repository.fetchById(id);
//
//   Future<void> fetchMostPopular({int page = 1, int limit = 20}) async {
//     try {
//       state = const AsyncValue.loading();
//       final products = await repository.fetchMostPopular(
//         page: page,
//         limit: limit,
//       );
//       state = AsyncValue.data(products);
//     } catch (e, st) {
//       state = AsyncValue.error(e, st);
//     }
//   }
//
//   Future<void> search(String query, {int page = 1, int limit = 20}) async {
//     try {
//       state = const AsyncValue.loading();
//       final products = await repository.search(query, page: page, limit: limit);
//       state = AsyncValue.data(products);
//     } catch (e, st) {
//       state = AsyncValue.error(e, st);
//     }
//   }
//
//   // ============ CREATE PRODUCT METHOD - UPDATED ============
//
//   Future<ApiResponse<Product>?> createProduct({
//     required String name,
//     required String description,
//     required double price,
//     required String category,
//     required List<File> imageFiles,
//     List<File>? videoFiles,
//     List<CreateProductOption> options = const [],
//     bool archived = false,
//   }) async {
//     final createState = ref.read(createProductStateProvider.notifier);
//     final loadingState = ref.read(createProductLoadingStateProvider.notifier);
//
//     try {
//       // Set loading states
//       loadingState.state = true;
//       createState.state = const AsyncValue.loading();
//
//       // Log input for debugging
//       print('📱 [NOTIFIER] Creating product with params:');
//       print('📱 [NOTIFIER] - Name: $name');
//       print('📱 [NOTIFIER] - Description: $description');
//       print('📱 [NOTIFIER] - Price: $price');
//       print('📱 [NOTIFIER] - Category: $category');
//       print('📱 [NOTIFIER] - Archived: $archived');
//       print('📱 [NOTIFIER] - Image files: ${imageFiles.length}');
//       print('📱 [NOTIFIER] - Video files: ${videoFiles?.length ?? 0}');
//       print('📱 [NOTIFIER] - Options: ${options.length}');
//
//       // Call repository method
//       final response = await repository.createProduct(
//         name: name,
//         description: description,
//         price: price,
//         category: category,
//         imageFiles: imageFiles,
//         videoFiles: videoFiles,
//         options: options,
//         archived: archived,
//       );
//
//       // Update state based on response
//       if (response.success) {
//         createState.state = AsyncValue.data(response);
//
//         // Add new product to the list if data exists
//         if (response.data != null) {
//           addProduct(response.data!);
//           print('✅ [NOTIFIER] Product added to list: ${response.data!.name}');
//         }
//
//         print('✅ [NOTIFIER] Product creation successful: ${response.message}');
//
//         // Clear state after 5 seconds
//         Future.delayed(const Duration(seconds: 5), () {
//           createState.state = const AsyncValue.data(null);
//         });
//       } else {
//         // Handle API success=false case
//         createState.state = AsyncValue.error(
//           Exception(response.message ?? 'Failed to create product'),
//           StackTrace.current,
//         );
//
//         print('❌ [NOTIFIER] API returned success=false: ${response.message}');
//
//         // Clear error after 8 seconds
//         Future.delayed(const Duration(seconds: 8), () {
//           createState.state = const AsyncValue.data(null);
//         });
//       }
//
//       return response;
//     } catch (e, st) {
//       // Handle exceptions
//       print('❌ [NOTIFIER] Error creating product: $e');
//       print('❌ [NOTIFIER] Stack trace: $st');
//
//       createState.state = AsyncValue.error(e, st);
//
//       // Clear error after 8 seconds
//       Future.delayed(const Duration(seconds: 8), () {
//         createState.state = const AsyncValue.data(null);
//       });
//
//       rethrow;
//     } finally {
//       // Always reset loading state
//       loadingState.state = false;
//       print('📱 [NOTIFIER] Create product operation completed');
//     }
//   }
//
//   // ============ SCHEDULE METHODS ============
//
//   Future<ScheduleResponse?> scheduleGoLive({
//     required String productId,
//     required DateTime goLiveAt,
//     required DateTime takeDownAt,
//     int graceMinutes = 0,
//   }) async {
//     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
//
//     try {
//       scheduleState.state = const AsyncValue.loading();
//
//       final response = await repository.scheduleGoLive(
//         productId: productId,
//         goLiveAt: goLiveAt,
//         takeDownAt: takeDownAt,
//         graceMinutes: graceMinutes,
//       );
//
//       scheduleState.state = AsyncValue.data(response);
//
//       // ✅ Fetch fresh product data and update cache
//       try {
//         final freshProduct = await fetchById(productId);
//         updateProductInList(productId, (_) => freshProduct);
//       } catch (e) {
//         // Silently fail - user can refresh manually
//       }
//
//       _autoClearScheduleState(scheduleState, seconds: 3);
//       return response;
//     } catch (e, st) {
//       scheduleState.state = AsyncValue.error(e, st);
//       _autoClearScheduleState(scheduleState, seconds: 5);
//       rethrow;
//     }
//   }
//
//   // Take product down (end live session)
//   Future<ScheduleResponse?> takeProductDown(String productId) async {
//     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
//
//     try {
//       scheduleState.state = const AsyncValue.loading();
//       final response = await repository.takeProductDown(productId);
//       scheduleState.state = AsyncValue.data(response);
//
//       // Update product in list to mark as offline
//       updateProductInList(productId, (product) {
//         return product.copyWith(
//           isLive: false,
//           liveUntil: null,
//           productSchedule: ProductSchedule(
//             goLiveAt: null,
//             takeDownAt: null,
//             graceMinutes: 0,
//             isLive: false,
//           ),
//         );
//       });
//
//       _autoClearScheduleState(scheduleState, seconds: 3);
//       return response;
//     } catch (e, st) {
//       scheduleState.state = AsyncValue.error(e, st);
//       _autoClearScheduleState(scheduleState, seconds: 5);
//       rethrow;
//     }
//   }
//
//   // Extend grace period for a live product
//   Future<ScheduleResponse?> extendGracePeriod({
//     required String productId,
//     required int extraMinutes,
//   }) async {
//     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
//
//     try {
//       scheduleState.state = const AsyncValue.loading();
//       final response = await repository.extendGracePeriod(
//         productId: productId,
//         extraMinutes: extraMinutes,
//       );
//       scheduleState.state = AsyncValue.data(response);
//
//       // Update product's grace period in the list
//       updateProductInList(productId, (product) {
//         final currentSchedule = product.productSchedule;
//         final currentGrace = currentSchedule?.graceMinutes ?? 0;
//
//         return product.copyWith(
//           productSchedule:
//               currentSchedule?.copyWith(
//                 graceMinutes: currentGrace + extraMinutes,
//               ) ??
//               ProductSchedule(graceMinutes: extraMinutes),
//         );
//       });
//
//       _autoClearScheduleState(scheduleState, seconds: 3);
//       return response;
//     } catch (e, st) {
//       scheduleState.state = AsyncValue.error(e, st);
//       _autoClearScheduleState(scheduleState, seconds: 5);
//       rethrow;
//     }
//   }
//
//   // Fix live statuses (admin/utility function)
//   Future<ScheduleResponse?> fixLiveStatuses() async {
//     final scheduleState = ref.read(scheduleOperationStateProvider.notifier);
//
//     try {
//       scheduleState.state = const AsyncValue.loading();
//       final response = await repository.fixLiveStatuses();
//       scheduleState.state = AsyncValue.data(response);
//       _autoClearScheduleState(scheduleState, seconds: 3);
//       return response;
//     } catch (e, st) {
//       scheduleState.state = AsyncValue.error(e, st);
//       _autoClearScheduleState(scheduleState, seconds: 5);
//       rethrow;
//     }
//   }
//
//   // ============ HELPER METHODS ============
//
//   // Update product in list
//   void updateProductInList(
//     String productId,
//     Product Function(Product) updateFn,
//   ) {
//     state.whenData((products) {
//       final index = products.indexWhere((p) => p.id == productId);
//       if (index != -1) {
//         final product = products[index];
//         final updatedProduct = updateFn(product);
//         final newProducts = List<Product>.from(products);
//         newProducts[index] = updatedProduct;
//         state = AsyncValue.data(newProducts);
//       }
//     });
//   }
//
//   // Add product to list
//   void addProduct(Product product) {
//     state.whenData((products) {
//       final newProducts = List<Product>.from(products);
//       newProducts.insert(0, product);
//       state = AsyncValue.data(newProducts);
//     });
//   }
//
//   // Remove product from list
//   void removeProduct(String productId) {
//     state.whenData((products) {
//       final newProducts = products.where((p) => p.id != productId).toList();
//       state = AsyncValue.data(newProducts);
//     });
//   }
//
//   // Update product directly
//   void updateProduct(Product updatedProduct) {
//     updateProductInList(updatedProduct.id, (_) => updatedProduct);
//   }
//
//   // Refresh a single product
//   Future<void> refreshProduct(String productId) async {
//     try {
//       final refreshedProduct = await fetchById(productId);
//       updateProduct(refreshedProduct);
//     } catch (e) {
//       // Silently fail
//     }
//   }
//
//   // Get product by ID
//   Product? getProductById(String productId) {
//     return state.maybeWhen(
//       data: (products) {
//         try {
//           return products.firstWhere((p) => p.id == productId);
//         } catch (_) {
//           return null;
//         }
//       },
//       orElse: () => null,
//     );
//   }
//
//   // Check if product exists
//   bool hasProduct(String productId) {
//     return state.maybeWhen(
//       data: (products) => products.any((p) => p.id == productId),
//       orElse: () => false,
//     );
//   }
//
//   // Clear product list
//   void clearProductList() {
//     state = const AsyncValue.data([]);
//   }
//
//   // Auto-clear schedule state
//   void _autoClearScheduleState(
//     StateController<AsyncValue<ScheduleResponse?>> scheduleState, {
//     required int seconds,
//   }) {
//     Future.delayed(Duration(seconds: seconds), () {
//       scheduleState.state = const AsyncValue.data(null);
//     });
//   }
//
//   // Get schedule operation state
//   AsyncValue<ScheduleResponse?> getScheduleOperationState() {
//     return ref.read(scheduleOperationStateProvider);
//   }
//
//   // Clear schedule operation state
//   void clearScheduleOperationState() {
//     ref.read(scheduleOperationStateProvider.notifier).state =
//         const AsyncValue.data(null);
//   }
//
//   // Get create product state
//   AsyncValue<ApiResponse<Product>?> getCreateProductState() {
//     return ref.read(createProductStateProvider);
//   }
//
//   // Clear create product state
//   void clearCreateProductState() {
//     ref.read(createProductStateProvider.notifier).state = const AsyncValue.data(
//       null,
//     );
//   }
//
//   // Get create product loading state
//   bool getCreateProductLoadingState() {
//     return ref.read(createProductLoadingStateProvider);
//   }
// }
// lib/features/products/notifiers/product_notifier.dart
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../data/models/create_product_model.dart';
import '../data/models/model_response.dart';
import '../data/models/productsModel.dart';
import '../data/models/update_product_model.dart'; // Add this import
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

// Schedule operation state provider
final scheduleOperationStateProvider =
    StateProvider<AsyncValue<ScheduleResponse?>>(
      (_) => const AsyncValue.data(null),
    );

// Create/Update product state provider
final createProductStateProvider =
    StateProvider<AsyncValue<ApiResponse<Product>?>>(
      (_) => const AsyncValue.data(null),
    );

// Create/Update product loading state provider
final createProductLoadingStateProvider = StateProvider<bool>((_) => false);

final productNotifierProvider =
    StateNotifierProvider<ProductNotifier, AsyncValue<List<Product>>>((ref) {
      final repo = ref.watch(productRepositoryProvider);
      return ProductNotifier(repo, ref);
    });

class ProductNotifier extends StateNotifier<AsyncValue<List<Product>>> {
  final ProductRepository repository;
  final Ref ref;

  ProductNotifier(this.repository, this.ref)
    : super(const AsyncValue.loading());

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

  // ============ CREATE PRODUCT METHOD ============

  Future<ApiResponse<Product>?> createProduct({
    required String name,
    required String description,
    required double price,
    required String category,
    required List<File> imageFiles,
    List<File>? videoFiles,
    List<CreateProductOption> options = const [],
    bool archived = false,
  }) async {
    final createState = ref.read(createProductStateProvider.notifier);
    final loadingState = ref.read(createProductLoadingStateProvider.notifier);

    try {
      // Set loading states
      loadingState.state = true;
      createState.state = const AsyncValue.loading();

      // Log input for debugging
      print('📱 [NOTIFIER] Creating product with params:');
      print('📱 [NOTIFIER] - Name: $name');
      print('📱 [NOTIFIER] - Description: $description');
      print('📱 [NOTIFIER] - Price: $price');
      print('📱 [NOTIFIER] - Category: $category');
      print('📱 [NOTIFIER] - Archived: $archived');
      print('📱 [NOTIFIER] - Image files: ${imageFiles.length}');
      print('📱 [NOTIFIER] - Video files: ${videoFiles?.length ?? 0}');
      print('📱 [NOTIFIER] - Options: ${options.length}');

      // Call repository method
      final response = await repository.createProduct(
        name: name,
        description: description,
        price: price,
        category: category,
        imageFiles: imageFiles,
        videoFiles: videoFiles,
        options: options,
        archived: archived,
      );

      // Update state based on response
      if (response.success) {
        createState.state = AsyncValue.data(response);

        // Add new product to the list if data exists
        if (response.data != null) {
          addProduct(response.data!);
          print('✅ [NOTIFIER] Product added to list: ${response.data!.name}');
        }

        print('✅ [NOTIFIER] Product creation successful: ${response.message}');

        // Clear state after 5 seconds
        Future.delayed(const Duration(seconds: 5), () {
          createState.state = const AsyncValue.data(null);
        });
      } else {
        // Handle API success=false case
        createState.state = AsyncValue.error(
          Exception(response.message ?? 'Failed to create product'),
          StackTrace.current,
        );

        print('❌ [NOTIFIER] API returned success=false: ${response.message}');

        // Clear error after 8 seconds
        Future.delayed(const Duration(seconds: 8), () {
          createState.state = const AsyncValue.data(null);
        });
      }

      return response;
    } catch (e, st) {
      // Handle exceptions
      print('❌ [NOTIFIER] Error creating product: $e');
      print('❌ [NOTIFIER] Stack trace: $st');

      createState.state = AsyncValue.error(e, st);

      // Clear error after 8 seconds
      Future.delayed(const Duration(seconds: 8), () {
        createState.state = const AsyncValue.data(null);
      });

      rethrow;
    } finally {
      // Always reset loading state
      loadingState.state = false;
      print('📱 [NOTIFIER] Create product operation completed');
    }
  }

  // ============ UPDATE PRODUCT METHOD ============

  Future<ApiResponse<Product>?> updateProduct({
    required String productId,
    String? name,
    String? description,
    double? price,
    String? category,
    List<String>? images,
    List<String>? video,
    List<UpdateProductOption>? options,
    bool? archived,
    List<File>? newImageFiles,
    List<File>? newVideoFiles,
  }) async {
    final updateState = ref.read(createProductStateProvider.notifier);
    final loadingState = ref.read(createProductLoadingStateProvider.notifier);

    try {
      // Set loading states
      loadingState.state = true;
      updateState.state = const AsyncValue.loading();

      // Log input for debugging
      print('📱 [NOTIFIER] Updating product: $productId');
      print('📱 [NOTIFIER] - Name: $name');
      print('📱 [NOTIFIER] - Description: $description');
      print('📱 [NOTIFIER] - Price: $price');
      print('📱 [NOTIFIER] - Category: $category');
      print('📱 [NOTIFIER] - Archived: $archived');
      print('📱 [NOTIFIER] - Images URLs: ${images?.length ?? 0}');
      print('📱 [NOTIFIER] - Video URLs: ${video?.length ?? 0}');
      print('📱 [NOTIFIER] - New image files: ${newImageFiles?.length ?? 0}');
      print('📱 [NOTIFIER] - New video files: ${newVideoFiles?.length ?? 0}');
      print('📱 [NOTIFIER] - Options: ${options?.length ?? 0}');

      // Call repository method
      final response = await repository.updateProduct(
        productId: productId,
        name: name,
        description: description,
        price: price,
        category: category,
        images: images,
        video: video,
        options: options,
        archived: archived,
        newImageFiles: newImageFiles,
        newVideoFiles: newVideoFiles,
      );

      // Update state based on response
      if (response.success) {
        updateState.state = AsyncValue.data(response);

        // Update product in the list if data exists
        if (response.data != null) {
          updateProductInList(productId, (_) => response.data!);
          print('✅ [NOTIFIER] Product updated in list: ${response.data!.name}');

          // Show what was updated
          if (name != null) print('✅ [NOTIFIER] - Name updated');
          if (price != null) print('✅ [NOTIFIER] - Price updated');
          if (images != null) print('✅ [NOTIFIER] - Images updated');
          if (newImageFiles != null && newImageFiles.isNotEmpty)
            print('✅ [NOTIFIER] - ${newImageFiles.length} new images added');
          if (options != null) print('✅ [NOTIFIER] - Options updated');
        }

        print('✅ [NOTIFIER] Product update successful: ${response.message}');

        // Clear state after 5 seconds
        Future.delayed(const Duration(seconds: 5), () {
          updateState.state = const AsyncValue.data(null);
        });
      } else {
        // Handle API success=false case
        updateState.state = AsyncValue.error(
          Exception(response.message ?? 'Failed to update product'),
          StackTrace.current,
        );

        print('❌ [NOTIFIER] API returned success=false: ${response.message}');

        // Clear error after 8 seconds
        Future.delayed(const Duration(seconds: 8), () {
          updateState.state = const AsyncValue.data(null);
        });
      }

      return response;
    } catch (e, st) {
      // Handle exceptions
      print('❌ [NOTIFIER] Error updating product: $e');
      print('❌ [NOTIFIER] Stack trace: $st');

      updateState.state = AsyncValue.error(e, st);

      // Clear error after 8 seconds
      Future.delayed(const Duration(seconds: 8), () {
        updateState.state = const AsyncValue.data(null);
      });

      rethrow;
    } finally {
      // Always reset loading state
      loadingState.state = false;
      print('📱 [NOTIFIER] Update product operation completed');
    }
  }

  // ============ SCHEDULE METHODS ============

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

      // ✅ Fetch fresh product data and update cache
      try {
        final freshProduct = await fetchById(productId);
        updateProductInList(productId, (_) => freshProduct);
      } catch (e) {
        // Silently fail - user can refresh manually
      }

      _autoClearScheduleState(scheduleState, seconds: 3);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      _autoClearScheduleState(scheduleState, seconds: 5);
      rethrow;
    }
  }

  // Take product down (end live session)
  Future<ScheduleResponse?> takeProductDown(String productId) async {
    final scheduleState = ref.read(scheduleOperationStateProvider.notifier);

    try {
      scheduleState.state = const AsyncValue.loading();
      final response = await repository.takeProductDown(productId);
      scheduleState.state = AsyncValue.data(response);

      // Update product in list to mark as offline
      updateProductInList(productId, (product) {
        return product.copyWith(
          isLive: false,
          liveUntil: null,
          productSchedule: ProductSchedule(
            goLiveAt: null,
            takeDownAt: null,
            graceMinutes: 0,
            isLive: false,
          ),
        );
      });

      _autoClearScheduleState(scheduleState, seconds: 3);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      _autoClearScheduleState(scheduleState, seconds: 5);
      rethrow;
    }
  }

  // Extend grace period for a live product
  Future<ScheduleResponse?> extendGracePeriod({
    required String productId,
    required int extraMinutes,
  }) async {
    final scheduleState = ref.read(scheduleOperationStateProvider.notifier);

    try {
      scheduleState.state = const AsyncValue.loading();
      final response = await repository.extendGracePeriod(
        productId: productId,
        extraMinutes: extraMinutes,
      );
      scheduleState.state = AsyncValue.data(response);

      // Update product's grace period in the list
      updateProductInList(productId, (product) {
        final currentSchedule = product.productSchedule;
        final currentGrace = currentSchedule?.graceMinutes ?? 0;

        return product.copyWith(
          productSchedule:
              currentSchedule?.copyWith(
                graceMinutes: currentGrace + extraMinutes,
              ) ??
              ProductSchedule(graceMinutes: extraMinutes),
        );
      });

      _autoClearScheduleState(scheduleState, seconds: 3);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      _autoClearScheduleState(scheduleState, seconds: 5);
      rethrow;
    }
  }

  // Fix live statuses (admin/utility function)
  Future<ScheduleResponse?> fixLiveStatuses() async {
    final scheduleState = ref.read(scheduleOperationStateProvider.notifier);

    try {
      scheduleState.state = const AsyncValue.loading();
      final response = await repository.fixLiveStatuses();
      scheduleState.state = AsyncValue.data(response);
      _autoClearScheduleState(scheduleState, seconds: 3);
      return response;
    } catch (e, st) {
      scheduleState.state = AsyncValue.error(e, st);
      _autoClearScheduleState(scheduleState, seconds: 5);
      rethrow;
    }
  }

  // ============ HELPER METHODS ============

  // Update product in list
  void updateProductInList(
    String productId,
    Product Function(Product) updateFn,
  ) {
    state.whenData((products) {
      final index = products.indexWhere((p) => p.id == productId);
      if (index != -1) {
        final product = products[index];
        final updatedProduct = updateFn(product);
        final newProducts = List<Product>.from(products);
        newProducts[index] = updatedProduct;
        state = AsyncValue.data(newProducts);
      }
    });
  }

  // Add product to list
  void addProduct(Product product) {
    state.whenData((products) {
      final newProducts = List<Product>.from(products);
      newProducts.insert(0, product);
      state = AsyncValue.data(newProducts);
    });
  }

  // Remove product from list
  void removeProduct(String productId) {
    state.whenData((products) {
      final newProducts = products.where((p) => p.id != productId).toList();
      state = AsyncValue.data(newProducts);
    });
  }

  // Update product directly (for external use)
  void updateProductDirectly(Product updatedProduct) {
    updateProductInList(updatedProduct.id!, (_) => updatedProduct);
  }

  // Refresh a single product
  Future<void> refreshProduct(String productId) async {
    try {
      final refreshedProduct = await fetchById(productId);
      updateProductInList(productId, (_) => refreshedProduct);
    } catch (e) {
      // Silently fail
    }
  }

  // Get product by ID
  Product? getProductById(String productId) {
    return state.maybeWhen(
      data: (products) {
        try {
          return products.firstWhere((p) => p.id == productId);
        } catch (_) {
          return null;
        }
      },
      orElse: () => null,
    );
  }

  // Check if product exists
  bool hasProduct(String productId) {
    return state.maybeWhen(
      data: (products) => products.any((p) => p.id == productId),
      orElse: () => false,
    );
  }

  // Clear product list
  void clearProductList() {
    state = const AsyncValue.data([]);
  }

  // Auto-clear schedule state
  void _autoClearScheduleState(
    StateController<AsyncValue<ScheduleResponse?>> scheduleState, {
    required int seconds,
  }) {
    Future.delayed(Duration(seconds: seconds), () {
      scheduleState.state = const AsyncValue.data(null);
    });
  }

  // Get schedule operation state
  AsyncValue<ScheduleResponse?> getScheduleOperationState() {
    return ref.read(scheduleOperationStateProvider);
  }

  // Clear schedule operation state
  void clearScheduleOperationState() {
    ref.read(scheduleOperationStateProvider.notifier).state =
        const AsyncValue.data(null);
  }

  // Get create/update product state
  AsyncValue<ApiResponse<Product>?> getCreateProductState() {
    return ref.read(createProductStateProvider);
  }

  // Clear create/update product state
  void clearCreateProductState() {
    ref.read(createProductStateProvider.notifier).state = const AsyncValue.data(
      null,
    );
  }

  // Get create/update product loading state
  bool getCreateProductLoadingState() {
    return ref.read(createProductLoadingStateProvider);
  }
}
