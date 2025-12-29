import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../data/models/address_model.dart';
import '../../data/models/user_model.dart';
import '../../notifiers/auth_notifier.dart';

class ProfilePage extends ConsumerWidget {
  const ProfilePage({super.key});

  // 🎨 Theme Colors
  static const Color backgroundColor = Color(0xFFF8F9FF);
  static const Color primaryBlue = Color(0xFF4169E1);
  static const Color deepBlue = Color(0xFF1A237E);
  static const Color accentYellow = Color(0xFFFFD300);
  static const Color cardBackground = Colors.white;
  static const Color cardShadow = Color(0x22000000);
  static const Color textColor = Color(0xFF102A43);
  static const Color secondaryText = Color(0xFF3B4CCA);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authNotifierProvider);
    final user = authState.user?.user;

    if (authState.isLoading) {
      return const Scaffold(
        backgroundColor: backgroundColor,
        body: Center(child: CircularProgressIndicator(color: primaryBlue)),
      );
    }

    if (user == null) {
      return const Scaffold(
        backgroundColor: backgroundColor,
        body: Center(
          child: Text("No user data found.", style: TextStyle(color: textColor)),
        ),
      );
    }

    final screenHeight = MediaQuery.of(context).size.height;

    return Scaffold(
      backgroundColor: backgroundColor,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        title: const Text(
          "Profile",
          style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
        ),
        centerTitle: true,
        backgroundColor: Colors.transparent,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: Colors.white),
            onPressed: () async {
              await ref.read(authNotifierProvider.notifier).logout();
              Navigator.of(context).pushReplacementNamed('/login');
            },
          ),
        ],
      ),
      body: CustomScrollView(
        slivers: [
          // 🔹 Banner + floating avatar
          SliverToBoxAdapter(
            child: Stack(
              clipBehavior: Clip.none,
              alignment: Alignment.center,
              children: [
                Container(
                  height: screenHeight * 0.35,
                  width: double.infinity,
                  decoration: BoxDecoration(
                    image: user.brandLogo != null
                        ? DecorationImage(
                        image: NetworkImage(user.brandLogo!), fit: BoxFit.cover)
                        : null,
                    gradient: user.brandLogo == null
                        ? const LinearGradient(
                      colors: [primaryBlue, deepBlue],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    )
                        : null,
                  ),
                ),
                Positioned(
                  bottom: -50,
                  child: CircleAvatar(
                    radius: 50,
                    backgroundColor: Colors.white,
                    backgroundImage:
                    user.avatarUrl != null ? NetworkImage(user.avatarUrl!) : null,
                    child: user.avatarUrl == null
                        ? const Icon(Icons.person, size: 50, color: Colors.grey)
                        : null,
                  ),
                ),
              ],
            ),
          ),

          // 🔹 Name, email, role (sticky header)
          SliverPersistentHeader(
            pinned: true,
            delegate: _ProfileHeaderDelegate(
              user: user,
              maxHeight: 120,
              minHeight: 100,
              backgroundColor: backgroundColor,
              accentYellow: accentYellow,
              textColor: textColor,
            ),
          ),

          // 🔹 Scrollable content
          SliverToBoxAdapter(
            child: Container(
              width: double.infinity,
              decoration: const BoxDecoration(
                color: cardBackground,
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(32),
                  topRight: Radius.circular(32),
                ),
                boxShadow: [
                  BoxShadow(
                    color: cardShadow,
                    blurRadius: 10,
                    offset: Offset(0, -3),
                  ),
                ],
              ),
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
              child: _buildScrollableContent(user),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildScrollableContent(User user) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildSectionTitle("Personal Info"),
        const SizedBox(height: 10),
        _buildInfoCard(Icons.person, "Username", user.username ?? "-"),
        _buildInfoCard(Icons.phone, "Phone", user.phoneNumber ?? "-"),
        _buildInfoCard(Icons.info_outline, "Bio", user.bio ?? "-"),
        const SizedBox(height: 24),

        if (user.preferences.isNotEmpty) ...[
          _buildSectionTitle("Preferences"),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: user.preferences
                .map(
                  (pref) => Container(
                padding:
                const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(
                  color: accentYellow.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  pref,
                  style: const TextStyle(
                    color: secondaryText,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            )
                .toList(),
          ),
          const SizedBox(height: 24),
        ],

        if (user.role == Role.vendor) ...[
          _buildSectionTitle("Brand Info"),
          const SizedBox(height: 10),
          _buildInfoCard(Icons.storefront, "Brand Name", user.brandName ?? "-"),
          const SizedBox(height: 24),
        ],

        if ((user as dynamic).addresses != null &&
            (user as dynamic).addresses.isNotEmpty) ...[
          _buildSectionTitle("Addresses"),
          const SizedBox(height: 8),
          ...((user as dynamic).addresses as List<Address>)
              .map(
                (addr) => _buildInfoCard(
              Icons.location_on,
              addr.label,
              "${addr.street}, ${addr.city}, ${addr.state}, ${addr.country}",
            ),
          )
              .toList(),
          const SizedBox(height: 32),
        ],
      ],
    );
  }

  Widget _buildSectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Text(
        title,
        style: const TextStyle(
          fontSize: 20,
          fontWeight: FontWeight.bold,
          color: primaryBlue,
        ),
      ),
    );
  }

  Widget _buildInfoCard(IconData icon, String label, String value) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: cardBackground,
        borderRadius: BorderRadius.circular(18),
        boxShadow: const [
          BoxShadow(
            color: cardShadow,
            blurRadius: 6,
            offset: Offset(0, 3),
          ),
        ],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: deepBlue),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: textColor,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  value,
                  style: TextStyle(color: textColor, height: 1.3),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ProfileHeaderDelegate extends SliverPersistentHeaderDelegate {
  final User user;
  final double maxHeight;
  final double minHeight;
  final Color backgroundColor;
  final Color accentYellow;
  final Color textColor;

  _ProfileHeaderDelegate({
    required this.user,
    required this.maxHeight,
    required this.minHeight,
    required this.backgroundColor,
    required this.accentYellow,
    required this.textColor,
  });

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    final shrinkFactor = shrinkOffset / (maxExtent - minExtent);

    return Container(
      color: backgroundColor,
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      alignment: Alignment.centerLeft,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            user.name,
            style: TextStyle(
              fontSize: 20 * (1 - shrinkFactor).clamp(0.7, 1.0),
              fontWeight: FontWeight.bold,
              color: textColor,
            ),
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 4),
          Text(
            user.email,
            style: TextStyle(
              fontSize: 14 * (1 - shrinkFactor).clamp(0.7, 1.0),
              color: Colors.black54,
            ),
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            decoration: BoxDecoration(
              color: accentYellow,
              borderRadius: BorderRadius.circular(20),
            ),
            child: Text(
              user.role.name.toUpperCase(),
              style: const TextStyle(
                fontWeight: FontWeight.bold,
                color: Colors.black87,
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  double get maxExtent => maxHeight;

  @override
  double get minExtent => minHeight;

  @override
  bool shouldRebuild(covariant _ProfileHeaderDelegate oldDelegate) => true;
}
